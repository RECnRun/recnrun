import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  namespaceFolder,
  runCatalog,
  writePresence,
} from "../../experiments/fixtures/e4-launcher.ts";
import { POC_EXTENSION_ID, createDownloadsGroup, tempPlatform } from "./downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "./downloads-profiles.ts";
import { presenceOf, within } from "./trust.ts";

/*
 * What the "Prepare workers" lab (POC P6.1) stands on: a real master, poc-d0 in Google Chrome with
 * the master role, whose dashboard asks; and provision.sh with the lab's stub Chrome for the base and
 * the clones (scripts/poc-cross-profile/provision-rig.mjs), run by the test as the launcher's loop would.
 */

const NAMESPACE = "lab";
const PRESENCE_MS = 30_000;
const PAGE_MS = 25_000;
const RIG = new URL("../../../scripts/poc-cross-profile/provision-rig.mjs", import.meta.url).href;
// The lab catalog checks only the form of an identity statement.
const IDENTITY = { key: "B".repeat(87), signedAt: 1_800_000_000_000, signature: "S".repeat(86) };

interface ProvisionRig {
  home: string;
  bases: string;
  record: string;
  state: string;
  folder(id: string): string;
  launchCount(): number;
  run(extra?: Record<string, string>): { code: number | null; out: string; err: string };
  installBase(): string;
  dispose(): void;
}

export interface MasterScene {
  group: DownloadsGroup;
  profile: DownloadsProfile;
  rig: ProvisionRig;
  dashboard: Page;
  identityKey: string;
  dispose(): Promise<void>;
}

const roleOf = (profileId: string, identity: string) => ({ role: "master", profileId, identity });

/** The launcher record: the master's block, which provision.sh and clone-open.sh read. */
const masterBlock = (profile: DownloadsProfile, downloads: string) =>
  [
    `userDataDir=${profile.root}`,
    "profileDirectory=Default",
    `profileId=${profile.profileId}`,
    `namespace=${NAMESPACE}`,
    "role=master",
    `downloadsRoot=${downloads}`,
    "",
  ].join("\n");

/** A master profile with poc-d0, its dashboard open, and a record, a state folder, and a stub base. */
export async function masterScene(): Promise<MasterScene> {
  const group = await createDownloadsGroup(tempPlatform("recnrun-onboarding"));
  let rig: ProvisionRig | undefined;
  try {
    const profile = await group.launch("Master");
    const presence = await within(() => presenceOf(group, profile), PRESENCE_MS);
    if (!presence) throw new Error("The master wrote no presence.");
    const identityKey = presence.identity.key;
    await profile.serviceWorker.evaluate(
      (role) =>
        (
          globalThis as unknown as {
            chrome: { storage: { local: { set(items: object): Promise<void> } } };
          }
        ).chrome.storage.local.set({ role }),
      roleOf(profile.profileId, identityKey),
    );
    const made = (await import(RIG)) as {
      provisionRig(options: { downloads: string; namespace: string }): ProvisionRig;
    };
    rig = made.provisionRig({ downloads: group.downloads, namespace: NAMESPACE });
    await writeFile(rig.record, masterBlock(profile, group.downloads));
    const dashboard = await profile.context.newPage();
    await dashboard.goto(`chrome-extension://${POC_EXTENSION_ID}/dashboard.html`);
    const owned = rig;
    return {
      group,
      profile,
      rig,
      dashboard,
      identityKey,
      dispose: async () => {
        owned.dispose();
        await group.dispose();
      },
    };
  } catch (error) {
    rig?.dispose();
    await group.dispose();
    throw error;
  }
}

/** One catalog.sh pass over the record, as the launcher's loop runs it after provision.sh. */
export async function catalogPass(scene: MasterScene): Promise<void> {
  const run = await runCatalog(scene.rig.record, scene.group.downloads);
  if (run.code !== 0) throw new Error(`catalog.sh exited ${run.code}: ${run.stderr}`);
}

const field = (page: Page, name: string) => page.locator(`[data-field="${name}"]`).first();

/** The text of a `data-field` of the section, or undefined while it is not there. */
export const fieldText = async (page: Page, name: string) =>
  (await field(page, name)
    .textContent({ timeout: 300 })
    .catch(() => null)) ?? undefined;

/** Waits until a field shows `text`; false when it does not within the time. */
export async function shows(page: Page, name: string, text: string, ms = PAGE_MS) {
  return (
    (await within(async () => ((await fieldText(page, name)) === text ? true : undefined), ms)) ===
    true
  );
}

/** Types the folder and the count, clicks Prepare, and answers the operation's id and request bytes. */
export async function prepare(scene: MasterScene, clones: number) {
  const { dashboard, rig } = scene;
  await dashboard.locator('[data-field="bases-dir"]').fill(rig.bases, { timeout: PAGE_MS });
  await dashboard.locator('[data-field="clones-count"]').fill(String(clones), { timeout: PAGE_MS });
  await dashboard.locator('[data-field="prepare"]').click({ timeout: PAGE_MS });
  const ops = join(namespaceFolder(scene.group.downloads), "ops");
  const id = await within(async () => (await readdir(ops))[0], PAGE_MS);
  if (!id) throw new Error("No operation folder appeared.");
  const file = join(ops, id, "request.json");
  const request = await within(() => readFile(file, "utf8"), PAGE_MS);
  if (!request) throw new Error("request.json was not written.");
  return { id, request };
}

/** The launcher's status.json of an operation, as written. */
export const statusOf = async (scene: MasterScene, id: string) =>
  await readFile(join(scene.rig.folder(id), "status.json"), "utf8");

interface CloneStatus {
  name: string;
  instanceId: string;
  boot: string;
  acked: boolean;
}

/** The worker block the record gained for `instanceId`: the Downloads root its clone acked under. */
async function rootOf(scene: MasterScene, instanceId: string): Promise<string> {
  const blocks = (await readFile(scene.rig.record, "utf8")).split(/\n\s*\n/);
  const block = blocks.find((each) => each.includes(`profileId=${instanceId}`));
  const root = block?.match(/^downloadsRoot=(.*)$/m)?.[1];
  if (!root) throw new Error(`The record has no root for ${instanceId}.`);
  return root;
}

/** The presence a booted clone would write, with the boot its ack carried, so the catalog lists it. */
export async function announceClone(scene: MasterScene, clone: CloneStatus): Promise<void> {
  const root = await rootOf(scene, clone.instanceId);
  await mkdir(join(namespaceFolder(root), "peers", clone.instanceId), { recursive: true });
  const createdAt = Date.now();
  await writePresence(root, {
    profileId: clone.instanceId,
    displayName: clone.name,
    fingerprint: "AB:CD:EF",
    identity: IDENTITY,
    createdAt,
    expiresAt: createdAt + 60_000,
    namespace: NAMESPACE,
    boot: clone.boot,
  });
}

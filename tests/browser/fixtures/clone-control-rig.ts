import { join } from "node:path";
import type { Page } from "@playwright/test";
import { POC_EXTENSION_ID, createDownloadsGroup, tempPlatform } from "./downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "./downloads-profiles.ts";
import { presenceOf, within } from "./trust.ts";

/*
 * What the dashboard's clone-control lab stands on: a real master (poc-d0 in Google Chrome with the
 * master role) whose dashboard asks, and the real launcher pass (recnrun-launcher.sh start --once)
 * over a record that names the master and one clone, with the lab's stub Chrome for the clone
 * (scripts/poc-cross-profile/clone-control-rig.mjs). No clones.json or status.json is written by the test.
 */

const RIG = new URL("../../../scripts/poc-cross-profile/clone-control-rig.mjs", import.meta.url)
  .href;
// The namespace the shell lab's clone folders use; the master joins it through chrome.storage.local.
const NAMESPACE = "lab-1";
const PRESENCE_MS = 30_000;

interface Run {
  code: number | null;
  out: string;
  err: string;
}

interface CloneControlRig {
  clone: string;
  requestFolder(id: string): string;
  pass(extra?: Record<string, string>): Run;
  hold(): Run;
  launches(): number;
  signals(): string[];
  field(key: string): string | undefined;
  clonesJson(): string;
  dispose(): void;
}

export interface CloneControlScene {
  group: DownloadsGroup;
  profile: DownloadsProfile;
  rig: CloneControlRig;
  dashboard: Page;
  identityKey: string;
  /** The folder the master writes requests under, in its own Downloads root. */
  control: string;
  dispose(): Promise<void>;
}

const setStorage = (profile: DownloadsProfile, items: object) =>
  profile.serviceWorker.evaluate(
    (values) =>
      (
        globalThis as unknown as {
          chrome: { storage: { local: { set(items: object): Promise<void> } } };
        }
      ).chrome.storage.local.set(values),
    items,
  );

/** A master with poc-d0 in the shell lab's namespace, its dashboard open, and a launcher record with one clone. */
export async function cloneControlScene(): Promise<CloneControlScene> {
  const group = await createDownloadsGroup(tempPlatform("recnrun-clone-control"));
  let rig: CloneControlRig | undefined;
  try {
    const profile = await group.launch("Master");
    const presence = await within(() => presenceOf(group, profile), PRESENCE_MS);
    if (!presence) throw new Error("The master wrote no presence.");
    await setStorage(profile, {
      role: { role: "master", profileId: profile.profileId, identity: presence.identity.key },
      pocNamespace: NAMESPACE,
    });
    const made = (await import(RIG)) as {
      cloneControlRig(options: { downloads: string; masterId: string }): CloneControlRig;
    };
    rig = made.cloneControlRig({ downloads: group.downloads, masterId: profile.profileId });
    const dashboard = await profile.context.newPage();
    await dashboard.goto(`chrome-extension://${POC_EXTENSION_ID}/dashboard.html`);
    const owned = rig;
    return {
      group,
      profile,
      rig,
      dashboard,
      identityKey: presence.identity.key,
      control: join(group.downloads, "RECnRun", "poc", NAMESPACE, "control"),
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

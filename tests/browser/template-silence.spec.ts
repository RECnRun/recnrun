import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectEveryHypothesis, recordHypothesis } from "../experiments/outcome.ts";
import type { Cell, Sample } from "../experiments/outcome.ts";
import { expect, test } from "./fixtures/chrome.ts";
import { readOrAbsent } from "./fixtures/absence.ts";
import {
  POC_EXTENSION_ID,
  createDownloadsGroup,
  storedIn,
  tempPlatform,
} from "./fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "./fixtures/downloads-profiles.ts";

/*
 * POC PLAN.md P5.3 on Google Chrome Stable: a poc-d0 profile opened as a template announces
 * nothing, even after its Chrome restarts, while a second profile keeps announcing (the control);
 * a #clone= fragment that names a role is refused; the correct one provisions the template into
 * the instance it names, which acks with an identity of its own before its first presence; the
 * same fragment again answers with that identity, and another instance is refused.
 */

const EXPERIMENT = "P5.3";
const CELLS = [
  "P5.3.template.silent",
  "P5.3.template.forgedMaster",
  "P5.3.clone.provision",
  "P5.3.clone.idempotent",
  "P5.3.clone.conflict",
] as const;
// PRESENCE_TTL_MS of apps/extension/src/p2p/folder-rendezvous.ts.
const PRESENCE_TTL_MS = 60_000;
// One renewal's slack beyond the TTL, so a presence the template still owed would have landed.
const SETTLE_MS = 5_000;
const APPEAR_MS = 15_000;
const POLL_MS = 250;
const NAMESPACE = "clones";
const REFUSED =
  "The address carries no #clone=<token>&instance=<uuid>&operation=<uuid>&namespace=<namespace>&master=<profile id>.<identity key>.";

interface Statement {
  key: string;
}
interface Presence {
  profileId: string;
  createdAt: number;
  identity: Statement;
}
interface Ack {
  profileId: string;
  createdAt: number;
  identity?: Statement;
  instanceId?: string;
  operationId?: string;
  provisioned?: boolean;
}

interface Scene {
  group: DownloadsGroup;
  subject: DownloadsProfile;
  control: DownloadsProfile;
  /** The subject's identity key before it became a template. */
  before: string;
  master: { profileId: string; key: string };
  instanceId: string;
  token: string;
  operationId: string;
}

const readJson = <T>(path: string) =>
  readOrAbsent(async () => JSON.parse(await readFile(path, "utf8")) as T);

const presencePath = (scene: Scene, namespace: string, profileId: string) =>
  join(scene.group.downloads, "RECnRun/poc", namespace, "peers", profileId, "presence.json");
const ackPath = (scene: Scene, namespace: string, profileId: string, token: string) =>
  join(scene.group.downloads, "RECnRun/poc", namespace, "acks", profileId, `${token}.json`);

/** Polls `path` until its JSON satisfies `ready` or `ms` pass. */
async function waitFor<T>(path: string, ready: (value: T) => boolean, ms = APPEAR_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await readJson<T>(path);
    if (value !== undefined && ready(value)) return value;
    await delay(POLL_MS);
  }
  return undefined;
}

/** Opens the bootstrap page with `fragment` in the profile and answers what the page shows. */
async function openBootstrap(profile: DownloadsProfile, fragment: string) {
  const page = await profile.context.newPage();
  try {
    await page.goto(`chrome-extension://${POC_EXTENSION_ID}/bootstrap.html${fragment}`);
    const shown = page.locator("#bootstrap");
    await expect(shown).toHaveText(/^\{/, { timeout: APPEAR_MS });
    return JSON.parse(await shown.innerText()) as Record<string, unknown>;
  } finally {
    await page.close();
  }
}

const cloneFragment = (scene: Scene, overrides: { token?: string; instance?: string } = {}) =>
  `#clone=${overrides.token ?? scene.token}&instance=${overrides.instance ?? scene.instanceId}` +
  `&operation=${scene.operationId}&namespace=${NAMESPACE}` +
  `&master=${scene.master.profileId}.${scene.master.key}`;

/** A sample from named checks: it passes when none failed, and names each that did. */
function sampleOf(checks: Record<string, boolean>, observation: Record<string, unknown>): Sample {
  const failed = Object.entries(checks).flatMap(([name, ok]) => (ok ? [] : [name]));
  return failed.length === 0
    ? { ok: true, observation: { ...observation, checks } }
    : { ok: false, error: failed.join(", "), observation: { ...observation, checks } };
}

async function templateSilent(scene: Scene): Promise<Sample> {
  const { subject, control, group } = scene;
  const result = await openBootstrap(subject, `#template=${randomUUID()}&setting=base-v1`);
  const enteredAt = Date.now();
  const role = await storedIn(subject.serviceWorker, "local", "role");
  // The worker stops with its Chrome and starts again with the stored role.
  await group.quit(subject);
  await group.relaunch(subject);
  const own = presencePath(scene, "lab", subject.profileId);
  const late = await waitFor<Presence>(
    own,
    (p) => p.createdAt >= enteredAt,
    SETTLE_MS + PRESENCE_TTL_MS,
  );
  const controlPath = presencePath(scene, "lab", control.profileId);
  const heard = await waitFor<Presence>(controlPath, (p) => p.createdAt >= enteredAt, 1_000);
  const checks = {
    templateAcked: result.ok === true && result.acked === true,
    roleTemplate: JSON.stringify(role) === JSON.stringify({ role: "template" }),
    noPresenceForSettlePlusTtl: late === undefined,
    controlAnnounced: heard !== undefined,
  };
  const after = await storedIn(subject.serviceWorker, "local", "role");
  checks.roleTemplate &&= JSON.stringify(after) === JSON.stringify({ role: "template" });
  return sampleOf(checks, {
    result,
    watchedMs: SETTLE_MS + PRESENCE_TTL_MS,
    control: heard?.createdAt,
  });
}

async function forgedMaster(scene: Scene): Promise<Sample> {
  const token = randomUUID();
  const result = await openBootstrap(
    scene.subject,
    `${cloneFragment(scene, { token })}&role=master`,
  );
  const role = await storedIn(scene.subject.serviceWorker, "local", "role");
  const ack = await waitFor<Ack>(
    ackPath(scene, NAMESPACE, scene.instanceId, token),
    () => true,
    2_000,
  );
  return sampleOf(
    {
      refused: result.ok === false && result.error === REFUSED,
      roleStaysTemplate: JSON.stringify(role) === JSON.stringify({ role: "template" }),
      noAck: ack === undefined,
    },
    { result, role },
  );
}

/** What the first provisioning must show in its ack and in the presence that follows it. */
function provisioned(
  scene: Scene,
  ack: Ack | undefined,
  presence: Presence | undefined,
): Record<string, boolean> {
  if (!ack || !presence) return { ackWritten: ack !== undefined, presenceWritten: false };
  return {
    ackFields:
      ack.profileId === scene.instanceId &&
      ack.instanceId === scene.instanceId &&
      ack.operationId === scene.operationId &&
      ack.provisioned === true,
    newIdentity: ack.identity !== undefined && ack.identity.key !== scene.before,
    presenceAfterAck: presence.createdAt >= ack.createdAt,
    presenceIsInstance: presence.profileId === scene.instanceId,
    sameKeyInPresence: presence.identity.key === ack.identity?.key,
  };
}

async function provision(scene: Scene): Promise<Sample> {
  const result = await openBootstrap(scene.subject, cloneFragment(scene));
  const ackFile = ackPath(scene, NAMESPACE, scene.instanceId, scene.token);
  const ack = await waitFor<Ack>(ackFile, () => true);
  const presenceFile = presencePath(scene, NAMESPACE, scene.instanceId);
  const presence = await waitFor<Presence>(presenceFile, () => true);
  const role = await storedIn(scene.subject.serviceWorker, "local", "role");
  return sampleOf(
    {
      acked: result.ok === true && result.acked === true,
      ...provisioned(scene, ack, presence),
      roleWorker: (role as { role?: string } | undefined)?.role === "worker",
    },
    { result, ack, presenceCreatedAt: presence?.createdAt, role },
  );
}

async function idempotent(scene: Scene): Promise<Sample> {
  const path = ackPath(scene, NAMESPACE, scene.instanceId, scene.token);
  const first = await readJson<Ack>(path);
  const result = await openBootstrap(scene.subject, cloneFragment(scene));
  const again = await waitFor<Ack>(path, (ack) => ack.createdAt > (first?.createdAt ?? 0));
  return sampleOf(
    {
      acked: result.ok === true && result.acked === true,
      rewritten: again !== undefined,
      sameIdentity:
        again?.identity?.key !== undefined && again.identity.key === first?.identity?.key,
      sameInstance: again?.instanceId === scene.instanceId,
    },
    { result, first: first?.createdAt, again: again?.createdAt },
  );
}

async function conflict(scene: Scene): Promise<Sample> {
  const before = await readJson<Ack>(ackPath(scene, NAMESPACE, scene.instanceId, scene.token));
  const other = randomUUID();
  const token = randomUUID();
  const result = await openBootstrap(
    scene.subject,
    cloneFragment(scene, { token, instance: other }),
  );
  const stray = await waitFor<Ack>(ackPath(scene, NAMESPACE, other, token), () => true, 2_000);
  const identity = await storedIn(scene.subject.serviceWorker, "local", "profileIdentity");
  // The same instance asked once more shows the key the refusal left in place.
  const check = randomUUID();
  await openBootstrap(scene.subject, cloneFragment(scene, { token: check }));
  const after = await waitFor<Ack>(ackPath(scene, NAMESPACE, scene.instanceId, check), () => true);
  return sampleOf(
    {
      refused: result.ok === false && String(result.error).startsWith("conflicting identity: "),
      noAck: stray === undefined,
      profileUnchanged:
        (identity as { profileId?: string } | undefined)?.profileId === scene.instanceId,
      keyUnchanged:
        after?.identity?.key !== undefined && after.identity.key === before?.identity?.key,
    },
    { result, identity },
  );
}

test("a template announces nothing, and a clone provisions once into its own identity", async () => {
  test.setTimeout(420_000);
  const group = await createDownloadsGroup(tempPlatform("recnrun-template"));
  try {
    const subject = await group.launch("Template");
    const control = await group.launch("Control");
    const own = presencePath({ group } as Scene, "lab", subject.profileId);
    const first = await waitFor<Presence>(own, () => true);
    const master = await waitFor<Presence>(
      presencePath({ group } as Scene, "lab", control.profileId),
      () => true,
    );
    if (!first || !master) throw new Error("Neither profile announced itself before the cells.");
    const scene: Scene = {
      group,
      subject,
      control,
      before: first.identity.key,
      master: { profileId: master.profileId, key: master.identity.key },
      instanceId: randomUUID(),
      token: randomUUID(),
      operationId: randomUUID(),
    };
    const cell = (hypothesis: string): Cell => ({
      experiment: EXPERIMENT,
      hypothesis,
      chrome: subject.chrome.version,
      environment: "lab",
      install: "loadUnpacked",
      label: "diagnostic",
      externalClient: true,
      variant: "poc-d0",
      topology: "two profiles, one shared Downloads folder",
      debugger: "none",
    });
    const takes = [templateSilent, forgedMaster, provision, idempotent, conflict];
    for (const [index, take] of takes.entries()) {
      await recordHypothesis(cell(CELLS[index] as string), () => take(scene), { full: 1 });
    }
    await expectEveryHypothesis(EXPERIMENT, CELLS);
  } finally {
    await group.dispose();
  }
});

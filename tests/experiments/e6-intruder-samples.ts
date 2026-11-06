import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { linkedPeers, waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "../browser/fixtures/downloads-profiles.ts";
import {
  askPeers,
  dashboardOf,
  goneFrom,
  isActive,
  linesWith,
  sendOverLink,
  tabOf,
  workOf,
} from "../browser/fixtures/master-restart.ts";
import type { Hierarchy } from "../browser/fixtures/master-restart.ts";
import { backgroundLog } from "../browser/fixtures/trust.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import { namespaceFolder } from "./fixtures/e4-launcher.ts";
import { signalWrites, within } from "./fixtures/e5-observe.ts";
import { arriving, quiet, virtualIn } from "./fixtures/e5-run.ts";
import type { E5Environment } from "./fixtures/e5-run.ts";
import {
  bootOf,
  changedSince,
  hierarchiesOf,
  nextBoot,
  pinnedKey,
  storeIn,
  unless,
  watchLink,
  withHierarchy,
} from "./fixtures/e6-run.ts";

/*
 * E6's cells where someone else claims the closed master's place (POC PLAN.md P3.5): a forger
 * under the Default's id with a key of its own, and a third profile that records itself as master;
 * then a worker restart, the case a master restart must not be mistaken for.
 */

const GONE_MS = 30_000;
const REFUSED_MS = 30_000;
const MESH_MS = 60_000;
const RELINK_MS = 60_000;
const ACTIVE_MS = 10_000;

/** The master quits and both workers see it go. */
async function masterGone(group: DownloadsGroup, { master, workers }: Hierarchy) {
  await group.quit(master);
  return Promise.all(workers.map((each) => goneFrom(each, master, GONE_MS)));
}

/** Whether `log` refused the forger, as the offerer (its presence) or the answerer (its offer). */
const refusedForger = (log: string[], masterId: string) =>
  linesWith(log, `no offer to ${masterId}: its certificate is signed by another identity`).length +
    linesWith(log, `Refused a code from ${masterId}: its pinned identity did not sign`).length >
  0;

/** E6.a.forgedMaster: a presence and offers under the closed Default's id, signed by another key. */
export const forgedMasterSample = (environment: E5Environment) =>
  withHierarchy(environment, async (group, hierarchy) => {
    const { master, workers } = hierarchy;
    const before = await hierarchiesOf(workers);
    const logs = workers.map((each) => backgroundLog(each.context));
    await masterGone(group, hierarchy);
    const forgedAt = Date.now();
    const forger = await virtualIn(group, workers[0], master.profileId);
    await forger.announce();
    const pairings: string[] = [];
    for (const each of workers) {
      const offer = await forger.signal("offer", each.profileId);
      pairings.push(offer.pairingId);
      await forger.write("offer", each.profileId, JSON.stringify(offer));
    }
    const refused = await Promise.all(
      logs.map((log) =>
        within(async () => (refusedForger(log, master.profileId) ? true : undefined), REFUSED_MS),
      ),
    );
    await quiet();
    const writes = (await Promise.all(workers.map(signalWrites))).flat();
    const observation = {
      refusedMs: refused.map((each) => (each ? each.at - forgedAt : undefined)),
      linkedToForger: await Promise.all(
        workers.map(async (each) => (await linkedPeers(each)).includes(master.profileId)),
      ),
      forgerConnected: (await forger.linkStates()).includes("connected"),
      answersToForger: writes.filter((each) => pairings.includes(each.pairingId)).length,
      offersToForger: writes.filter(
        (each) => each.name === `offer-${master.profileId}.json` && each.startedAt > forgedAt,
      ).length,
      changed: await changedSince(workers, before),
    };
    forger.stop();
    // The forger poisoned nothing: the real Default comes back and links under its pins.
    await group.relaunch(master);
    const relinkMs = await waitForMesh([master, ...workers], RELINK_MS).catch(() => undefined);
    const problems = [
      ...unless(refused.every(Boolean), "a worker logged no refusal of the forger"),
      ...unless(!observation.linkedToForger.some(Boolean), "a worker linked with the forger"),
      ...unless(!observation.forgerConnected, "the forger's connection came up"),
      ...unless(observation.answersToForger === 0, "a worker answered the forger's offer"),
      ...unless(observation.offersToForger === 0, "a worker offered to the forger"),
      ...unless(observation.changed.length === 0, `${observation.changed.join(", ")} changed`),
      ...unless(relinkMs !== undefined, "the real Default did not link again"),
    ];
    return judged(problems, { ...observation, relinkMs });
  });

/** The intruder records itself as master of both workers and says so in its presence. */
async function claimMaster(
  group: DownloadsGroup,
  intruder: DownloadsProfile,
  workers: DownloadsProfile[],
) {
  const boundAt = Date.now();
  const boundWorkers: Record<string, unknown> = {};
  for (const each of workers)
    boundWorkers[each.profileId] = {
      identity: await pinnedKey(intruder, each),
      boundAt,
      source: "pairing",
    };
  const identity = await pinnedKey(workers[0] ?? intruder, intruder);
  await storeIn(intruder, {
    boundWorkers,
    role: { role: "master", profileId: intruder.profileId, identity },
  });
  const path = join(namespaceFolder(group.downloads), "peers", intruder.profileId, "presence.json");
  const presence = JSON.parse(await readFile(path, "utf8")) as object;
  await writeFile(path, JSON.stringify({ ...presence, role: "master" }));
}

/** The intruder's commands to `worker`: a frame with a role field, a tab switch, and a session start. */
async function commandsTo(intruder: DownloadsProfile, worker: DownloadsProfile, log: string[]) {
  const from = log.length;
  const tabId = await tabOf(worker, "the intruder's target");
  await sendOverLink(intruder, worker, { type: "SESSION_START", tabId, role: "master" });
  await sendOverLink(intruder, worker, { type: "ACTIVATE_TAB", tabId });
  await sendOverLink(intruder, worker, { type: "SESSION_START", tabId });
  const refusal = (type: string) =>
    `REFUSED ${type} from ${intruder.profileId}: not the bound master`;
  const refused = await within(async () => {
    const found = ["ACTIVATE_TAB", "SESSION_START"].every(
      (type) => linesWith(log, refusal(type), from).length > 0,
    );
    return found ? true : undefined;
  }, REFUSED_MS);
  return {
    dropped: linesWith(log, "dropped an invalid frame", from).length,
    refused: refused !== undefined,
    tabActive: await isActive(worker, tabId),
    session: (await workOf(worker)).session,
  };
}

/** E6.a.thirdMaster: a third profile links with the workers, records itself as master, and commands. */
export const thirdMasterSample = (environment: E5Environment) =>
  withHierarchy(environment, async (group, hierarchy) => {
    const { workers } = hierarchy;
    const before = await hierarchiesOf(workers);
    const logs = workers.map((each) => backgroundLog(each.context));
    await masterGone(group, hierarchy);
    const intruder = await arriving(group, "Intruder");
    const meshMs = await waitForMesh([intruder, ...workers], MESH_MS).catch(() => undefined);
    if (meshMs === undefined)
      return judged([`the third profile did not link within ${MESH_MS} ms`], {});
    await claimMaster(group, intruder, workers);
    const commands = [];
    for (const [index, each] of workers.entries())
      commands.push(await commandsTo(intruder, each, logs[index] ?? []));
    // A first meeting pins the intruder; the role, the bound workers, and the master's pin stay.
    const masterId = hierarchy.master.profileId;
    const kept = (record?: { role: unknown; boundWorkers: unknown; peerPins: unknown }) => ({
      role: record?.role,
      boundWorkers: record?.boundWorkers,
      masterPin: (record?.peerPins as Record<string, unknown> | undefined)?.[masterId],
    });
    const changed = await changedSince(workers, before, kept);
    const observation = { meshMs, commands, changed };
    const problems = [
      ...unless(
        commands.every((each) => each.dropped > 0),
        "a frame with a role field was not dropped",
      ),
      ...unless(
        commands.every((each) => each.refused),
        "a worker did not refuse the intruder's commands",
      ),
      ...unless(
        commands.every((each) => !each.tabActive),
        "a worker switched tabs for the intruder",
      ),
      ...unless(
        commands.every((each) => each.session === null),
        "a worker started a session for the intruder",
      ),
      ...unless(
        observation.changed.length === 0,
        `${observation.changed.join(", ")} changed its hierarchy`,
      ),
    ];
    return judged(problems, observation);
  });

/** E6.c.workerRestart: Worker 2 restarts; the master stays up, keeps Worker 1, and commands Worker 2 again. */
export const workerRestartSample = (environment: E5Environment) =>
  withHierarchy(environment, async (group, { master, workers }) => {
    const [steady, restarting] = workers;
    const before = await hierarchiesOf([master, restarting]);
    const [masterBoot, boot] = [await bootOf(group, master), await bootOf(group, restarting)];
    const stopWatch = watchLink(master, steady);
    await group.quit(restarting);
    const goneMs = await goneFrom(master, restarting, GONE_MS);
    const relaunched = Date.now();
    await group.relaunch(restarting);
    const fresh = await nextBoot(group, restarting, boot);
    const relinkMs = await waitForMesh([master, ...workers], RELINK_MS).then(
      () => Date.now() - relaunched,
      () => undefined,
    );
    const watched = await stopWatch();
    const tabId = await tabOf(restarting, "after the restart");
    const activate = { type: "activate", peer: restarting.profileId, tabId };
    const reply = await askPeers(await dashboardOf(master), activate);
    const active = await within(
      async () => ((await isActive(restarting, tabId)) ? true : undefined),
      ACTIVE_MS,
    );
    const observation = {
      goneMs,
      relinkMs,
      newWorkerBoot: fresh !== undefined,
      masterBootKept: (await bootOf(group, master)) === masterBoot,
      steadyLinkDrops: watched.drops,
      steadyLinkPolls: watched.polls,
      changed: await changedSince([master, restarting], before),
      commandAccepted: reply.ok,
      tabActive: active !== undefined,
    };
    const problems = [
      ...unless(goneMs !== undefined, "the master kept its link to the closed worker"),
      ...unless(relinkMs !== undefined, `no link within ${RELINK_MS} ms of the relaunch`),
      ...unless(observation.newWorkerBoot, "the relaunched worker kept its earlier boot"),
      ...unless(observation.masterBootKept, "the master restarted"),
      ...unless(watched.drops === 0, "the master's link with Worker 1 dropped"),
      ...unless(
        observation.changed.length === 0,
        `${observation.changed.join(", ")} changed its hierarchy`,
      ),
      ...unless(
        reply.ok && observation.tabActive,
        "the master's command did not run in the restarted worker",
      ),
    ];
    return judged(problems, observation);
  });

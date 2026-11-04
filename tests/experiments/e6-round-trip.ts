import { isDeepStrictEqual } from "node:util";
import type { Page } from "@playwright/test";
import { linkedPeers, waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup } from "../browser/fixtures/downloads-profiles.ts";
import {
  askPeers,
  dashboardOf,
  goneFrom,
  linesWith,
  startWork,
  workOf,
} from "../browser/fixtures/master-restart.ts";
import type { Hierarchy } from "../browser/fixtures/master-restart.ts";
import { backgroundLog } from "../browser/fixtures/trust.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import type { Sample } from "./fixtures/downloads-verdicts.ts";
import {
  longestGap,
  presenceRewrites,
  recordOf,
  within,
  workerListed,
} from "./fixtures/e5-observe.ts";
import { catalogued, identityOf } from "./fixtures/e5-run.ts";
import type { E5Environment } from "./fixtures/e5-run.ts";
import { PRESENCE_TTL_MS } from "./fixtures/e5-virtual.ts";
import {
  bootOf,
  changedSince,
  entryOf,
  hierarchiesOf,
  nextBoot,
  startedWork,
  statusIn,
  statusOf,
  unless,
  withHierarchy,
} from "./fixtures/e6-run.ts";

/*
 * E6's round trip (POC PLAN.md P3.5): the master starts a session in Worker 1 and quits; both
 * workers run unattended past the master presence's lifetime; the same Default comes back on its
 * root. One round trip is one sample of each of the four cells it feeds, judged apart.
 */

/** A closed peer's link drops on ICE or DataChannel close, well within this. */
const GONE_MS = 30_000;
/** Past the master presence's lifetime, so the catalog drops it and each worker renews its own. */
const ABSENT_MS = PRESENCE_TTL_MS + 15_000;
const CATALOG_EVERY_MS = 2_000;
const WORK_MS = 10_000;
/** A relaunched profile links again within two retry periods (RETRY_MS, 30 s, of folder-pairing.ts). */
const RELINK_MS = 60_000;
const STATUS_MS = 15_000;
const STOP_MS = 10_000;

export type RoundTripCell = "E6.a.absent" | "E6.b.relink" | "E6.b.status" | "E6.b.results";
type RoundTrip = Record<RoundTripCell, Sample>;

/** What the master left when it quit. */
interface Left {
  group: DownloadsGroup;
  hierarchy: Hierarchy;
  before: Awaited<ReturnType<typeof hierarchiesOf>>;
  work: Awaited<ReturnType<typeof workOf>>;
  tabId: number;
  boot: string | undefined;
}

/** While the master is closed: how its workers saw it go, and what they wrote on disk unattended. */
async function absence({ group, hierarchy: { master, workers } }: Left) {
  await group.quit(master);
  const quitAt = Date.now();
  const goneMs = await Promise.all(workers.map((each) => goneFrom(each, master, GONE_MS)));
  for (const each of workers) await group.detach(each);
  const unlisted = within(
    async () =>
      (await catalogued(group, master.profileId)).listed ? undefined : Date.now() - quitAt,
    ABSENT_MS,
    CATALOG_EVERY_MS,
  );
  const rewrites = await Promise.all(
    workers.map((each) => presenceRewrites(group.downloads, each.profileId, ABSENT_MS)),
  );
  const end = Date.now();
  const listed = await Promise.all(workers.map(workerListed));
  for (const each of workers) await group.attach(each);
  return { goneMs, unlistedMs: (await unlisted)?.value, rewrites, end, listed };
}

const isWorker = (record: { role: unknown; boundWorkers: unknown }) =>
  (record.role as { role?: string } | null)?.role === "worker" && record.boundWorkers === null;

/** E6.a.absent: the workers keep running, their binding, the link between them, and the session. */
async function whileAbsent(left: Left): Promise<Sample> {
  const [busy, idle] = left.hierarchy.workers;
  const seen = await absence(left);
  const workers = [busy, idle];
  const roles = await hierarchiesOf(workers);
  const observation = {
    goneMs: seen.goneMs,
    masterUnlistedMs: seen.unlistedMs,
    presenceWrites: seen.rewrites.map((each) => each.length),
    longestPresenceGapMs: seen.rewrites.map((each) => longestGap(each, seen.end)),
    serviceWorkersListed: seen.listed,
    changed: await changedSince(workers, left.before.slice(1)),
    stillWorkers: roles.every(isWorker),
    workersLinked: (await linkedPeers(busy)).includes(idle.profileId),
    sessionKept: isDeepStrictEqual(await workOf(busy), left.work),
    controlledBy: (await statusIn(busy)).controlledBy,
  };
  const problems = [
    ...unless(
      seen.goneMs.every((each) => each !== undefined),
      "a worker kept its link to the closed Default",
    ),
    ...unless(
      seen.unlistedMs !== undefined,
      `the catalog still listed the Default after ${ABSENT_MS} ms`,
    ),
    ...unless(
      observation.longestPresenceGapMs.every((each) => each < PRESENCE_TTL_MS),
      "a worker's presence lapsed",
    ),
    ...unless(
      observation.changed.length === 0,
      `${observation.changed.join(", ")} changed its hierarchy`,
    ),
    ...unless(observation.stillWorkers, "a worker took another role"),
    ...unless(observation.workersLinked, "the workers lost their link"),
    ...unless(observation.sessionKept, "the session in Worker 1 changed"),
    ...unless(
      observation.controlledBy === null,
      "Worker 1 still reports the closed Default in control",
    ),
  ];
  return judged(problems, observation);
}

/** Why the master and a worker hold no link: each side's link record and Worker 1's last lines. */
async function unlinked({ hierarchy: { master, workers } }: Left, log: string[]) {
  const links = await Promise.all(
    workers.map(async (each) => ({
      worker: each.name,
      toMaster: await recordOf(each, "session", "peerLinks", master),
      fromMaster: await recordOf(master, "session", "peerLinks", each),
    })),
  );
  return { links, busyLog: log.slice(-15) };
}

/** E6.b.relink: the same Default links with both workers again, under the records it had. */
async function relinked(left: Left, page: () => Promise<Page>, log: string[]): Promise<Sample> {
  const { group, hierarchy } = left;
  const { master, workers } = hierarchy;
  const relaunched = Date.now();
  await group.relaunch(master);
  const fresh = await nextBoot(group, master, left.boot);
  const linked = await waitForMesh([master, ...workers], RELINK_MS).then(
    () => Date.now(),
    () => undefined,
  );
  await page();
  const observation = {
    relinkFromLaunchMs: linked === undefined ? undefined : linked - relaunched,
    relinkFromPresenceMs: linked === undefined || !fresh ? undefined : linked - fresh.createdAt,
    newBoot: fresh !== undefined,
    sameProfileId: (await identityOf(master)).profileId === master.profileId,
    changed: await changedSince([master, ...workers], left.before),
    ...(linked === undefined && { unlinked: await unlinked(left, log) }),
  };
  const problems = [
    ...unless(linked !== undefined, `no link with both workers within ${RELINK_MS} ms`),
    ...unless(observation.newBoot, "the relaunched Default kept its earlier boot"),
    ...unless(observation.sameProfileId, "the relaunched Default has another profile id"),
    ...unless(
      observation.changed.length === 0,
      `${observation.changed.join(", ")} changed its hierarchy or pins`,
    ),
  ];
  return judged(problems, observation);
}

const RECORDING = { status: "recording", mine: true, live: true };

/** E6.b.status: the master's dashboard shows Worker 1's session as its own, live, and its tabs. */
async function statusBack(left: Left, page: Page): Promise<Sample> {
  const [busy, idle] = left.hierarchy.workers;
  const started = Date.now();
  const seen = await within(async () => {
    const status = await statusOf(page);
    return entryOf(status, busy)?.peerSession?.live ? status : undefined;
  }, STATUS_MS);
  const status = seen?.value ?? (await statusOf(page));
  const tabs = await askPeers(page, { type: "tabs", peer: busy.profileId });
  const listed = tabs.ok ? (tabs.result as { tabs: { id: number }[] }).tabs : [];
  const observation = {
    statusMs: seen ? seen.at - started : undefined,
    busySession: entryOf(status, busy)?.peerSession ?? null,
    idleSession: entryOf(status, idle)?.peerSession ?? null,
    linksVerified: [busy, idle].map((each) => entryOf(status, each)?.link.verified ?? false),
    listsWork: listed.some((each) => each.id === left.tabId),
  };
  const problems = [
    ...unless(
      isDeepStrictEqual(observation.busySession, RECORDING),
      "the master does not show Worker 1's session as its own and live",
    ),
    ...unless(observation.idleSession === null, "the master shows a session in Worker 2"),
    ...unless(observation.linksVerified.every(Boolean), "a worker's link is not verified"),
    ...unless(observation.listsWork, "Worker 1's tabs lack the session's tab"),
  ];
  return judged(problems, observation);
}

/** E6.b.results: nothing ran twice, and the master's next command reaches the session that waited. */
async function resultsBack(left: Left, page: Page, log: string[]): Promise<Sample> {
  const [busy] = left.hierarchy.workers;
  const sessionKept = isDeepStrictEqual(await workOf(busy), left.work);
  const stop = await askPeers(page, { type: "session-stop", peer: busy.profileId });
  const asked = Date.now();
  const stopped = await within(
    async () => ((await workOf(busy)).session === null ? true : undefined),
    STOP_MS,
  );
  const observation = {
    startsAfterRelaunch: linesWith(log, "received SESSION_START").length,
    sessionKept,
    stopAccepted: stop.ok,
    stopMs: stopped ? stopped.at - asked : undefined,
  };
  const problems = [
    ...unless(observation.startsAfterRelaunch === 0, "Worker 1 received another SESSION_START"),
    ...unless(sessionKept, "the session in Worker 1 changed before the master was back"),
    ...unless(stop.ok, `the master's stop was refused: ${stop.ok ? "" : stop.error}`),
    ...unless(stopped !== undefined, `the session did not stop within ${STOP_MS} ms`),
  ];
  return judged(problems, observation);
}

/** One round trip: the four cells' samples, each judged on its own phase. */
const roundTrip = (environment: E5Environment): Promise<RoundTrip> =>
  withHierarchy(environment, async (group, hierarchy) => {
    const { master, workers } = hierarchy;
    const tabId = await startWork(await dashboardOf(master), workers[0]);
    const work = await startedWork(workers[0], WORK_MS);
    if (!work) throw new Error(`No session started in Worker 1 within ${WORK_MS} ms.`);
    const before = await hierarchiesOf([master, ...workers]);
    const left = { group, hierarchy, before, work, tabId, boot: await bootOf(group, master) };
    const absent = await whileAbsent(left);
    const log = backgroundLog(workers[0].context);
    let page: Page | undefined;
    const open = async () => (page ??= await dashboardOf(master));
    const relink = await relinked(left, open, log);
    const status = await statusBack(left, await open());
    const results = await resultsBack(left, await open(), log);
    return {
      "E6.a.absent": absent,
      "E6.b.relink": relink,
      "E6.b.status": status,
      "E6.b.results": results,
    };
  });

/** Each environment's round trips, and how many of them each cell has taken. */
const trips = new WeakMap<
  E5Environment,
  { runs: Promise<RoundTrip>[]; taken: Map<string, number> }
>();

/** The sample of `cell` from the next round trip it has not taken, run when no cell ran it yet. */
export const tripSample = (cell: RoundTripCell) => async (environment: E5Environment) => {
  const state = trips.get(environment) ?? { runs: [], taken: new Map<string, number>() };
  trips.set(environment, state);
  const index = state.taken.get(cell) ?? 0;
  state.taken.set(cell, index + 1);
  state.runs[index] ??= roundTrip(environment);
  return (await state.runs[index])[cell];
};

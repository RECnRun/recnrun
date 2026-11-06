import { setTimeout as delay } from "node:timers/promises";
import {
  createDownloadsGroup,
  linkedPeers,
  storedIn,
} from "../../browser/fixtures/downloads-profiles.ts";
import type {
  DownloadsGroup,
  DownloadsPlatform,
  DownloadsProfile,
} from "../../browser/fixtures/downloads-profiles.ts";
import type { VerdictTarget } from "./downloads-verdicts.ts";
import { namespaceFolder } from "./e4-launcher.ts";
import { presenceStamp, signalWrites, within } from "./e5-observe.ts";
import { virtualPeer } from "./e5-virtual.ts";
import type { StampedSignal, VirtualPeer } from "./e5-virtual.ts";

/*
 * E5's runs (POC PLAN.md P3.2): the Default and its workers on throwaway roots that share one
 * Downloads folder, a stand-in launcher that reruns catalog.sh, and the virtual peer the
 * negative controls write as.
 */

/** The Default, then its workers, in launch order. */
const NAMES = ["Default", "Worker 1", "Worker 2", "Worker 3", "Worker 4"];
const PRESENCE_MS = 15_000;
/** Three polls of the watch (POLL_MS, 1 s) and one catalog period (2 s), with margin. */
const QUIET_MS = 6_000;
/** How long an answer to an offer the virtual peer wrote may take: a poll and gatherTimeoutMs (10 s) of peer-link.ts. */
export const ANSWER_MS = 15_000;
const HISTORY_EVERY_MS = 100;

/** Where E5 runs: the verdicts' target and a fresh platform for each sample. */
export interface E5Environment {
  target: VerdictTarget;
  platform(): DownloadsPlatform;
}

/** The virtual peers of each group, stopped with it, so none writes into a later sample's folder. */
const virtuals = new WeakMap<DownloadsGroup, VirtualPeer[]>();

/** Runs `run` on a group of its own, stopped and removed afterwards with its virtual peers. */
export async function withGroup<T>(
  environment: E5Environment,
  run: (group: DownloadsGroup) => Promise<T>,
): Promise<T> {
  const group = await createDownloadsGroup(environment.platform());
  try {
    return await run(group);
  } finally {
    for (const peer of virtuals.get(group) ?? []) peer.stop();
    await group.dispose();
  }
}

/** Launches the profile named `name` and waits for its first presence on disk. */
export async function arriving(group: DownloadsGroup, name: string): Promise<DownloadsProfile> {
  const profile = await group.launch(name);
  const present = await within(
    () => presenceStamp(group.downloads, profile.profileId),
    PRESENCE_MS,
  );
  if (!present) throw new Error(`${name} published no presence within ${PRESENCE_MS} ms`);
  return profile;
}

/** The first `count` profiles, each with its presence out, then the launcher's catalog every 2 s. */
export async function arrive(group: DownloadsGroup, count: number) {
  const profiles: DownloadsProfile[] = [];
  for (const name of NAMES.slice(0, count)) profiles.push(await arriving(group, name));
  const first = await group.catalog();
  group.startCatalog();
  return { profiles, first };
}

/** The pair as the rule elects it: the lower profile id offers, the other answers. */
export function pairOf(profiles: DownloadsProfile[]) {
  const [offerer, answerer] = [...profiles].sort((one, other) =>
    one.profileId < other.profileId ? -1 : 1,
  );
  if (!offerer || !answerer) throw new Error("A pair takes two profiles.");
  return { offerer, answerer };
}

/** Whether `profile` holds a verified, connected link with `peer` now. */
export const linkedWith = async (profile: DownloadsProfile, peer: DownloadsProfile) =>
  (await linkedPeers(profile)).includes(peer.profileId);

/** The profile's local records that must outlive a restart: its id and its pins. */
export async function identityOf(profile: DownloadsProfile) {
  const identity = (await storedIn(profile.serviceWorker, "local", "profileIdentity")) as
    | { profileId?: string }
    | undefined;
  return {
    profileId: identity?.profileId,
    pins: JSON.stringify((await storedIn(profile.serviceWorker, "local", "peerPins")) ?? {}),
  };
}

/** Scrubs the shared folder's path out of a catalog.sh message. */
const scrubbed = (text: string, downloads: string) =>
  text.replaceAll(namespaceFolder(downloads), "<namespace>").replaceAll(downloads, "<Downloads>");

/** A virtual peer `profileId` whose certificate lives in a blank tab of `host`; it writes nothing yet. */
export async function virtualIn(group: DownloadsGroup, host: DownloadsProfile, profileId: string) {
  const peer = await virtualPeer(await host.context.newPage(), group.downloads, profileId);
  virtuals.set(group, [...(virtuals.get(group) ?? []), peer]);
  return peer;
}

/** Whether the next catalog.sh run lists `profileId`, and what it logged, with no path. */
export async function catalogued(group: DownloadsGroup, profileId: string) {
  const run = await group.catalog();
  const listed = run.registry?.peers[profileId] !== undefined;
  return { listed, log: scrubbed(run.stderr, group.downloads).trim() };
}

/** A virtual peer, announced and listed by the catalog. */
export async function listedVirtual(
  group: DownloadsGroup,
  host: DownloadsProfile,
  profileId: string,
): Promise<VirtualPeer> {
  const peer = await virtualIn(group, host, profileId);
  await peer.announce();
  const { listed, log } = await catalogued(group, profileId);
  if (!listed) throw new Error(`catalog.sh did not list the virtual peer: ${log}`);
  return peer;
}

/** A virtual peer facing one real profile, in one group. */
export interface Facing {
  group: DownloadsGroup;
  peer: VirtualPeer;
  to: DownloadsProfile;
  /** How long each answer took, in the order the offers were written. */
  answers: number[];
  /** The pairings of every offer the profile must never answer. */
  unanswerable: string[];
}

/** A facing of `peer` that records into the same lists as `facing`. */
export const beside = (facing: Facing, peer: VirtualPeer): Facing => ({ ...facing, peer });

/** When the profile's history shows its answer to `pairingId` of the facing peer, if it does. */
async function answerOf({ peer, to }: Facing, pairingId: string) {
  const name = `answer-${peer.profileId}.json`;
  const writes = await signalWrites(to);
  return writes.find((each) => each.name === name && each.pairingId === pairingId)?.startedAt;
}

/** Writes `text` at the peer's offer file; how long until the profile answered `pairingId`, if it did within `ms`. */
export async function answerTo(
  facing: Facing,
  text: string,
  pairingId: string,
  ms: number,
): Promise<number | undefined> {
  const written = Date.now();
  await facing.peer.write("offer", facing.to.profileId, text);
  const answered = await within(() => answerOf(facing, pairingId), ms, HISTORY_EVERY_MS);
  if (!answered) return undefined;
  const took = Math.round(answered.value - written);
  facing.answers.push(took);
  return took;
}

/** Writes `signal` as the peer's offer: how long until the profile answered it, if it did. */
export const offered = (facing: Facing, signal: StampedSignal, ms = ANSWER_MS) =>
  answerTo(facing, JSON.stringify(signal), signal.pairingId, ms);

/** Writes `text` at the peer's offer file: true when no answer to `pairingId` came. */
export async function ignored(facing: Facing, text: string, pairingId: string) {
  facing.unanswerable.push(pairingId);
  return (await answerTo(facing, text, pairingId, QUIET_MS)) === undefined;
}

/** The offers the profile must never answer that its history shows an answer to, by now. */
export async function answeredLate({ to, unanswerable }: Facing): Promise<string[]> {
  const answered = new Set(
    (await signalWrites(to)).flatMap((each) =>
      each.name.startsWith("answer-") ? [each.pairingId] : [],
    ),
  );
  return unanswerable.filter((pairingId) => answered.has(pairingId));
}

/** Waits `ms`, the time a reader needs to see a file. */
export const quiet = (ms = QUIET_MS) => delay(ms);

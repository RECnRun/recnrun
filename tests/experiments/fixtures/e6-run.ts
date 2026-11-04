import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { Page } from "@playwright/test";
import { linkedPeers, storedIn } from "../../browser/fixtures/downloads-profiles.ts";
import type {
  DownloadsGroup,
  DownloadsProfile,
} from "../../browser/fixtures/downloads-profiles.ts";
import {
  askPeers,
  boundHierarchy,
  dashboardOf,
  hierarchyOf,
  workOf,
} from "../../browser/fixtures/master-restart.ts";
import type { Hierarchy } from "../../browser/fixtures/master-restart.ts";
import { presenceStamp, within } from "./e5-observe.ts";
import { withGroup } from "./e5-run.ts";
import type { E5Environment } from "./e5-run.ts";

/*
 * E6's runs (POC PLAN.md P3.5): the Default bound as the master of two workers on throwaway roots
 * that share one Downloads folder, with the stand-in launcher rerunning catalog.sh, and what each
 * sample reads of the hierarchy, the session the master started, and the master's dashboard.
 */

/** The Default's boot comes back within a presence write of the relaunch. */
const BOOT_MS = 15_000;
const WATCH_EVERY_MS = 250;

/** The hierarchy of a group of its own, removed afterwards. */
export const withHierarchy = <T>(
  environment: E5Environment,
  run: (group: DownloadsGroup, hierarchy: Hierarchy) => Promise<T>,
) => withGroup(environment, async (group) => run(group, await boundHierarchy(group)));

/** Each profile's hierarchy record, in the order given. */
export const hierarchiesOf = (profiles: DownloadsProfile[]) =>
  Promise.all(profiles.map(hierarchyOf));

type HierarchyRecord = Awaited<ReturnType<typeof hierarchyOf>>;

/** The names of the profiles whose record, as `pick` keeps it, differs from `before`, in the same order. */
export async function changedSince(
  profiles: DownloadsProfile[],
  before: HierarchyRecord[],
  pick: (record: HierarchyRecord | undefined) => unknown = (record) => record,
): Promise<string[]> {
  const now = await hierarchiesOf(profiles);
  return profiles
    .filter((_, index) => !isDeepStrictEqual(pick(now[index]), pick(before[index])))
    .map((each) => each.name);
}

/** The session in `profile` once one is stored, as workOf reads it. */
export const startedWork = async (profile: DownloadsProfile, ms: number) =>
  (await within(async () => ((await workOf(profile)).session ? workOf(profile) : undefined), ms))
    ?.value;

/** The status the background of `page`'s profile answers its dashboard. */
export interface StatusReply {
  controlledBy: string | null;
  peers: {
    peer: { profileId: string };
    link: { state: string; verified: boolean };
    peerSession: { status: string; mine: boolean; live: boolean } | null;
  }[];
}

export async function statusOf(page: Page): Promise<StatusReply> {
  const reply = await askPeers(page, { type: "status" });
  if (!reply.ok) throw new Error(`The status request failed: ${reply.error}`);
  return reply.result as StatusReply;
}

/** `peer`'s entry in `status`, if it lists it. */
export const entryOf = (status: StatusReply, peer: DownloadsProfile) =>
  status.peers.find((each) => each.peer.profileId === peer.profileId);

/** The status `profile` answers from a dashboard tab of its own, closed afterwards. */
export async function statusIn(profile: DownloadsProfile): Promise<StatusReply> {
  const page = await dashboardOf(profile);
  try {
    return await statusOf(page);
  } finally {
    await page.close();
  }
}

/** Counts each poll that finds `profile` without a verified link to `peer`, until stopped. */
export function watchLink(profile: DownloadsProfile, peer: DownloadsProfile) {
  const watching = { on: true, polls: 0, drops: 0 };
  const done = (async () => {
    while (watching.on) {
      watching.polls += 1;
      const linked = await linkedPeers(profile).catch(() => [] as string[]);
      if (!linked.includes(peer.profileId)) watching.drops += 1;
      await delay(WATCH_EVERY_MS);
    }
  })();
  return async () => {
    watching.on = false;
    await done;
    return { polls: watching.polls, drops: watching.drops };
  };
}

/** The boot of `profile`'s presence on disk now. */
export const bootOf = async (group: DownloadsGroup, profile: DownloadsProfile) =>
  (await presenceStamp(group.downloads, profile.profileId))?.boot;

/** The presence `profile` writes under a boot other than `boot`, once it lands. */
export const nextBoot = async (group: DownloadsGroup, profile: DownloadsProfile, boot?: string) =>
  (
    await within(async () => {
      const stamp = await presenceStamp(group.downloads, profile.profileId);
      return stamp && stamp.boot !== boot ? stamp : undefined;
    }, BOOT_MS)
  )?.value;

/** Writes `items` into `profile`'s local storage, as only a test does. */
export const storeIn = (profile: DownloadsProfile, items: Record<string, unknown>) =>
  profile.serviceWorker.evaluate(
    (values) =>
      (
        globalThis as unknown as {
          chrome: { storage: { local: { set(items: object): Promise<void> } } };
        }
      ).chrome.storage.local.set(values),
    items,
  );

/** The identity key `profile` pinned for `peer`. */
export async function pinnedKey(profile: DownloadsProfile, peer: DownloadsProfile) {
  const pins = (await storedIn(profile.serviceWorker, "local", "peerPins")) as
    | Record<string, { identity: string }>
    | undefined;
  return pins?.[peer.profileId]?.identity;
}

/** `[message]` unless `held`, so a list of problems reads as its conditions. */
export const unless = (held: boolean, message: string): string[] => (held ? [] : [message]);

import { setTimeout as delay } from "node:timers/promises";
import { linkedPeers, waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "../browser/fixtures/downloads-profiles.ts";
import { labE5 } from "./fixtures/e5-lab.ts";
import { presenceStamp, within } from "./fixtures/e5-observe.ts";
import { arrive, withGroup } from "./fixtures/e5-run.ts";
import { measured, meter } from "./fixtures/e7-downloads.ts";
import type { Policy } from "./fixtures/e7-downloads.ts";
import { launcherPresence } from "./fixtures/e7-launcher.ts";

/*
 * E7's recovery probes (POC PLAN.md P3.6), each on a group of its own so their writes stay out of
 * the steady window's rate: a silent policy must still let a profile that left be noticed, and a
 * launcher presence must still let a profile that comes back link again.
 */

export const PRESENCE_TTL_MS = 60_000;
export const RENEWAL_MS = PRESENCE_TTL_MS / 2;
// A heartbeat policy renews on the first alarm after a TTL of silence, by its definition.
const HEARTBEAT_BOUND_MS = PRESENCE_TTL_MS + RENEWAL_MS + 5_000;
const REJOIN_MS = 90_000;

/** The launcher stand-in renewing every profile of `profiles`. */
export const startLauncher = (group: DownloadsGroup, profiles: DownloadsProfile[]) =>
  launcherPresence(
    group.downloads,
    profiles.map((profile) => profile.profileId),
  );

async function meshOf(group: DownloadsGroup, policy: Policy) {
  const { profiles } = await arrive(group, 5);
  await waitForMesh(profiles);
  const launcher = policy === "launcher" ? startLauncher(group, profiles) : undefined;
  for (const profile of profiles) await meter(profile, policy);
  const quitting = profiles.at(-1);
  if (!quitting) throw new Error("No fifth profile.");
  return { profiles, launcher, quitting, survivors: profiles.slice(0, -1) };
}

const sixLinks = async (survivors: DownloadsProfile[]) =>
  (await Promise.all(survivors.map(linkedPeers))).every((peers) => peers.length === 3);

/** A silent policy after the fifth profile quits: how soon the four survivors write a presence again. */
async function resumed(group: DownloadsGroup, policy: Policy) {
  const { quitting, survivors } = await meshOf(group, policy);
  const droppedAt = Date.now();
  await group.quit(quitting);
  const bound = policy === "heartbeat" ? HEARTBEAT_BOUND_MS : PRESENCE_TTL_MS;
  const result = await within(
    async () => {
      const stamps = await Promise.all(
        survivors.map((profile) => presenceStamp(group.downloads, profile.profileId)),
      );
      return stamps.every((stamp) => stamp && stamp.createdAt > droppedAt) ? stamps : undefined;
    },
    bound,
    250,
  );
  const renewedAfterMs = result?.at === undefined ? undefined : result.at - droppedAt;
  const observation = { boundMs: bound, renewedAfterMs, sixLinksRemain: await sixLinks(survivors) };
  const problems = [
    ...(renewedAfterMs === undefined || renewedAfterMs > bound
      ? [`presence did not resume within ${bound} ms after the fifth profile quit`]
      : []),
    ...(!observation.sixLinksRemain ? ["the surviving four lost a link"] : []),
  ];
  return { problems, observation };
}

/** A launcher presence after the fifth profile quits for longer than a TTL and comes back. */
async function rejoined(group: DownloadsGroup) {
  const { profiles, launcher, quitting, survivors } = await meshOf(group, "launcher");
  if (!launcher) throw new Error("No launcher.");
  launcher.drop(quitting.profileId);
  await group.quit(quitting);
  // Every presence the extensions wrote has expired by now; only the launcher's remain.
  await delay(PRESENCE_TTL_MS + 5_000);
  const sixLinksRemain = await sixLinks(survivors);
  const before = await presenceStamp(group.downloads, quitting.profileId);
  const relaunchedAt = Date.now();
  await group.relaunch(quitting);
  launcher.add(quitting.profileId);
  const rejoinedMs = await waitForMesh(profiles, REJOIN_MS).catch(() => undefined);
  const after = await presenceStamp(group.downloads, quitting.profileId);
  const survivorPresenceCalls = (await Promise.all(survivors.map(measured))).reduce(
    (sum, count) => sum + count.presenceCalls,
    0,
  );
  const launched = await launcher.stop();
  const observation = {
    sixLinksRemain,
    relaunchedAfterMs: relaunchedAt - (before?.createdAt ?? relaunchedAt),
    newBoot: before?.boot !== after?.boot,
    rejoinedMs,
    survivorPresenceCalls,
    launcherWrites: launched.writes,
  };
  const problems = [
    ...(!sixLinksRemain ? ["the surviving four lost a link"] : []),
    ...(rejoinedMs === undefined
      ? [`the fifth profile did not link again within ${REJOIN_MS} ms`]
      : []),
    ...(survivorPresenceCalls > 0 ? ["a survivor wrote its own presence"] : []),
  ];
  return { problems, observation };
}

interface Probe {
  problems: string[];
  observation: Record<string, unknown>;
}

/** The recovery probe of `policy`, on a fresh group of five. */
export const recovery = (policy: Policy) =>
  withGroup<Probe>(labE5, (group) =>
    policy === "launcher" ? rejoined(group) : resumed(group, policy),
  );

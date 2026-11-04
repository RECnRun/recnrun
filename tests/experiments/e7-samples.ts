import { setTimeout as delay } from "node:timers/promises";
import { linkedPeers, waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup } from "../browser/fixtures/downloads-profiles.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import { labE5 } from "./fixtures/e5-lab.ts";
import { presenceStamp, within } from "./fixtures/e5-observe.ts";
import { arrive, withGroup } from "./fixtures/e5-run.ts";
import { complete, measured, meter, visibleDownloads } from "./fixtures/e7-downloads.ts";
import type { Cell } from "./outcome.ts";
import { sampleMode } from "./samples.ts";

export const E7_CELLS = [
  "E7.baseline",
  "E7.variant.linkedSilence",
  "E7.variant.heartbeat",
  "E7.variant.launcherPresence",
] as const;
export type E7Hypothesis = (typeof E7_CELLS)[number];
const TTL_MS = 60_000;
const FULL_WINDOW_MS = 185_000;
const SMOKE_WINDOW_MS = 35_000;

export const e7Cell = async (hypothesis: E7Hypothesis): Promise<Cell> => ({
  experiment: "E7",
  hypothesis,
  chrome: await labE5.target.chrome(),
  environment: "lab" as const,
  install: "loadUnpacked" as const,
  label: "diagnostic" as const,
  externalClient: true,
  variant: "poc-d0",
  topology: "Default plus four workers, one shared Downloads root, ten DataChannels",
  debugger: "none" as const,
});

/** A separate recovery probe keeps its writes out of the steady-state rate and completion counts. */
async function recovery() {
  return withGroup(labE5, async (group) => {
    const { profiles } = await arrive(group, 5);
    await waitForMesh(profiles);
    for (const profile of profiles) await meter(profile, "linked-silence");
    const quitting = profiles.at(-1);
    if (!quitting) throw new Error("No fifth profile.");
    const droppedAt = Date.now();
    await group.quit(quitting);
    const survivors = profiles.slice(0, -1);
    const result = await within(
      async () => {
        const stamps = await Promise.all(
          survivors.map((profile) => presenceStamp(group.downloads, profile.profileId)),
        );
        return stamps.every((stamp) => stamp && stamp.createdAt > droppedAt) ? stamps : undefined;
      },
      TTL_MS,
      250,
    );
    const renewedAfterMs = result?.at === undefined ? undefined : result.at - droppedAt;
    const sixLinksRemain = (await Promise.all(survivors.map(linkedPeers))).every(
      (peers) => peers.length === 3,
    );
    return { renewedAfterMs, renewedProfiles: result ? survivors.length : 0, sixLinksRemain };
  });
}

interface Measurement {
  counts: Awaited<ReturnType<typeof measured>>[];
  silence: boolean;
  linkedAfterWindow: boolean;
  afterCompletion: Awaited<ReturnType<typeof complete>>[];
  downloadsPerHour: number;
}

function measurementProblems({
  counts,
  silence,
  linkedAfterWindow,
  afterCompletion,
  downloadsPerHour,
}: Measurement) {
  const minimum = sampleMode() === "smoke" ? 1 : 6;
  return [
    ...(!linkedAfterWindow ? ["the ten links did not survive the window"] : []),
    ...(counts.some((count) => count.otherCalls + count.signalCalls > 0)
      ? ["non-presence writes in a steady mesh"]
      : []),
    ...(!silence && counts.some((count) => count.presenceCalls < minimum)
      ? [`fewer than ${minimum} renewals in a profile`]
      : []),
    ...(silence && downloadsPerHour > 100
      ? [`linked silence still costs ${downloadsPerHour} downloads/hour`]
      : []),
    ...(afterCompletion.some((count) => count.history.signal > 0)
      ? ["signal items remained after folder-stop"]
      : []),
  ];
}

async function measure(group: DownloadsGroup, silence: boolean) {
  const { profiles } = await arrive(group, 5);
  const formedMs = await waitForMesh(profiles);
  const before = [];
  for (const profile of profiles)
    before.push(await meter(profile, silence ? "linked-silence" : "baseline"));
  const windowMs = sampleMode() === "smoke" ? SMOKE_WINDOW_MS : FULL_WINDOW_MS;
  await delay(windowMs);
  const counts = [];
  for (const [index, profile] of profiles.entries()) {
    const count = await measured(profile);
    counts.push({
      ...count,
      historyBefore: before[index],
      chromeDownloads: await visibleDownloads(profile, count.history.total),
    });
  }
  const linkedAfterWindow = (await Promise.all(profiles.map(linkedPeers))).every(
    (peers) => peers.length === 4,
  );
  const afterCompletion = [];
  for (const profile of profiles)
    afterCompletion.push({ profile: profile.name, ...(await complete(profile)) });
  const downloadsPerHour = counts.reduce((sum, count) => sum + count.downloadsPerHour, 0);
  const total = {
    calls: counts.reduce((sum, count) => sum + count.calls, 0),
    history: counts.reduce((sum, count) => sum + count.history.total, 0),
    historyAfterCompletion: afterCompletion.reduce((sum, count) => sum + count.history.total, 0),
    chromeDownloads: counts.reduce((sum, count) => sum + count.chromeDownloads, 0),
    chromeDownloadsAfterCompletion: afterCompletion.reduce(
      (sum, count) => sum + count.chromeDownloads,
      0,
    ),
    downloadsPerHour,
  };
  const problems = measurementProblems({
    counts,
    silence,
    linkedAfterWindow,
    afterCompletion,
    downloadsPerHour,
  });
  return {
    problems,
    observation: {
      policy: silence ? "linked-silence" : "baseline",
      requestedWindowMs: windowMs,
      smokeShortWindow: sampleMode() === "smoke",
      presenceTtlMs: TTL_MS,
      renewalMs: TTL_MS / 2,
      formedMs,
      linkedAfterWindow,
      profiles: counts,
      total,
      afterCompletion,
    },
  };
}

export async function presenceCostSample(silence: boolean) {
  const result = await withGroup(labE5, (group) => measure(group, silence));
  if (!silence) return judged(result.problems, result.observation);
  const resumed = await recovery();
  if (resumed.renewedAfterMs === undefined || resumed.renewedAfterMs > TTL_MS)
    result.problems.push("presence did not resume within one TTL after the fifth profile quit");
  if (!resumed.sixLinksRemain) result.problems.push("the surviving four lost a link");
  return judged(result.problems, { ...result.observation, recovery: resumed });
}

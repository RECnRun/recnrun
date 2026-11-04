import { setTimeout as delay } from "node:timers/promises";
import { linkedPeers, waitForMesh } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "../browser/fixtures/downloads-profiles.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import { labE5 } from "./fixtures/e5-lab.ts";
import { arrive, withGroup } from "./fixtures/e5-run.ts";
import { beatsOf, complete, measured, meter, visibleDownloads } from "./fixtures/e7-downloads.ts";
import type { HistoryCounts, Policy } from "./fixtures/e7-downloads.ts";
import { LAUNCHER_STAMPS, LAUNCHER_TAKES } from "./fixtures/e7-launcher.ts";
import { newcomer } from "./e7-newcomer.ts";
import { PRESENCE_TTL_MS, RENEWAL_MS, recovery, startLauncher } from "./e7-recovery.ts";
import type { Cell } from "./outcome.ts";
import { sampleMode } from "./samples.ts";

export const E7_CELLS = [
  "E7.baseline",
  "E7.variant.linkedSilence",
  "E7.variant.heartbeat",
  "E7.variant.launcherPresence",
  "E7.newcomer.linkedSilence",
  "E7.newcomer.heartbeat",
] as const;
export type E7Hypothesis = (typeof E7_CELLS)[number];
const POLICY: Record<E7Hypothesis, Policy> = {
  "E7.baseline": "baseline",
  "E7.variant.linkedSilence": "linked-silence",
  "E7.variant.heartbeat": "heartbeat",
  "E7.variant.launcherPresence": "launcher",
  "E7.newcomer.linkedSilence": "linked-silence",
  "E7.newcomer.heartbeat": "heartbeat",
};
const FULL_WINDOW_MS = 185_000;
const SMOKE_WINDOW_MS = 35_000;
const SILENT_MAX_PER_HOUR = 100;
const HOUR_MS = 3_600_000;

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

type Count = Awaited<ReturnType<typeof measured>>;
interface Measurement {
  policy: Policy;
  counts: Count[];
  linkedAfterWindow: boolean;
  afterCompletion: Awaited<ReturnType<typeof complete>>[];
  downloadsPerHour: number;
  listedAtEnd: number;
  launcherWrites?: Record<string, number>;
}

function launcherProblems({ policy, listedAtEnd, launcherWrites }: Measurement, minimum: number) {
  if (policy !== "launcher") return [];
  return [
    ...(listedAtEnd < 5 ? [`the catalog listed ${listedAtEnd} of five launcher presences`] : []),
    ...(Object.values(launcherWrites ?? {}).some((writes) => writes < minimum)
      ? [`the launcher renewed a profile fewer than ${minimum} times`]
      : []),
  ];
}

function measurementProblems(measurement: Measurement) {
  const { policy, counts, linkedAfterWindow, afterCompletion, downloadsPerHour } = measurement;
  const minimum = sampleMode() === "smoke" ? 1 : 6;
  return [
    ...(!linkedAfterWindow ? ["the ten links did not survive the window"] : []),
    ...(counts.some((count) => count.otherCalls + count.signalCalls > 0)
      ? ["non-presence writes in a steady mesh"]
      : []),
    ...(policy === "baseline" && counts.some((count) => count.presenceCalls < minimum)
      ? [`fewer than ${minimum} renewals in a profile`]
      : []),
    ...(policy !== "baseline" && downloadsPerHour > SILENT_MAX_PER_HOUR
      ? [`${policy} still costs ${downloadsPerHour} downloads/hour`]
      : []),
    ...launcherProblems(measurement, minimum),
    ...(afterCompletion.some((count) => count.history.signal > 0)
      ? ["signal items remained after folder-stop"]
      : []),
  ];
}

/** Profiles the launcher's catalog lists with an unexpired presence now. */
async function listedNow(group: DownloadsGroup, profiles: DownloadsProfile[]) {
  const peers = (await group.catalog()).registry?.peers ?? {};
  const now = Date.now();
  return profiles.filter((profile) => (peers[profile.profileId]?.expiresAt ?? 0) > now).length;
}

/** Counts each profile's calls and history, and the heartbeats its links sent, after the window. */
async function countAll(
  profiles: DownloadsProfile[],
  before: HistoryCounts[],
  beatsBefore: number[],
) {
  const counts = [];
  for (const [index, profile] of profiles.entries()) {
    const count = await measured(profile);
    const beats = (await beatsOf(profile)) - (beatsBefore[index] ?? 0);
    counts.push({
      ...count,
      historyBefore: before[index],
      chromeDownloads: await visibleDownloads(profile, count.history.total),
      heartbeatFrames: beats,
      heartbeatFramesPerHour: (beats * HOUR_MS) / count.windowMs,
    });
  }
  return counts;
}

const sum = <T>(items: T[], of: (item: T) => number) =>
  items.reduce((total, item) => total + of(item), 0);

/** One steady window under `policy`, the launcher stand-in renewing the presences when it applies. */
async function observeWindow(group: DownloadsGroup, profiles: DownloadsProfile[], policy: Policy) {
  const launcher = policy === "launcher" ? startLauncher(group, profiles) : undefined;
  const before = [];
  const beatsBefore = [];
  for (const profile of profiles) {
    before.push(await meter(profile, policy));
    beatsBefore.push(await beatsOf(profile));
  }
  await delay(sampleMode() === "smoke" ? SMOKE_WINDOW_MS : FULL_WINDOW_MS);
  const counts = await countAll(profiles, before, beatsBefore);
  const linkedAfterWindow = (await Promise.all(profiles.map(linkedPeers))).every(
    (peers) => peers.length === 4,
  );
  const listedAtEnd = await listedNow(group, profiles);
  const launched = await launcher?.stop();
  const afterCompletion = [];
  for (const profile of profiles)
    afterCompletion.push({ profile: profile.name, ...(await complete(profile)) });
  return { counts, linkedAfterWindow, listedAtEnd, launched, afterCompletion };
}

async function measure(group: DownloadsGroup, policy: Policy) {
  const { profiles } = await arrive(group, 5);
  const formedMs = await waitForMesh(profiles);
  const window = await observeWindow(group, profiles, policy);
  const { counts, afterCompletion } = window;
  const downloadsPerHour = sum(counts, (count) => count.downloadsPerHour);
  const total = {
    calls: sum(counts, (count) => count.calls),
    history: sum(counts, (count) => count.history.total),
    historyAfterCompletion: sum(afterCompletion, (count) => count.history.total),
    chromeDownloads: sum(counts, (count) => count.chromeDownloads),
    chromeDownloadsAfterCompletion: sum(afterCompletion, (count) => count.chromeDownloads),
    downloadsPerHour,
    heartbeatFramesPerHour: sum(counts, (count) => count.heartbeatFramesPerHour),
    launcherWritesPerHour: window.launched
      ? (sum(Object.values(window.launched.writes), (writes) => writes) * HOUR_MS) /
        (counts[0]?.windowMs ?? 1)
      : 0,
  };
  const measurement = {
    policy,
    ...window,
    downloadsPerHour,
    launcherWrites: window.launched?.writes,
  };
  return {
    problems: measurementProblems(measurement),
    observation: {
      policy,
      requestedWindowMs: sampleMode() === "smoke" ? SMOKE_WINDOW_MS : FULL_WINDOW_MS,
      smokeShortWindow: sampleMode() === "smoke",
      presenceTtlMs: PRESENCE_TTL_MS,
      renewalMs: RENEWAL_MS,
      formedMs,
      linkedAfterWindow: window.linkedAfterWindow,
      listedAtEnd: window.listedAtEnd,
      profiles: counts,
      total,
      afterCompletion,
      ...(window.launched
        ? { launcher: { ...window.launched, takes: LAUNCHER_TAKES, stamps: LAUNCHER_STAMPS } }
        : {}),
    },
  };
}

export async function presenceCostSample(hypothesis: E7Hypothesis) {
  const policy = POLICY[hypothesis];
  if (hypothesis.startsWith("E7.newcomer.")) {
    const found = await withGroup(labE5, (group) => newcomer(group, policy));
    return judged(found.problems, found.observation);
  }
  const result = await withGroup(labE5, (group) => measure(group, policy));
  if (policy === "baseline") return judged(result.problems, result.observation);
  const resumed = await recovery(policy);
  return judged([...result.problems, ...resumed.problems], {
    ...result.observation,
    recovery: resumed.observation,
  });
}

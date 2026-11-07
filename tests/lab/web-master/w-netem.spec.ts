import { rm } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended, ledger, settle, submitDirect } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import { call, jobOps, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import { impairUdp, pingWithin, restore, sampleFor, slowReceiver } from "./netem-harness.ts";
import type { Sample } from "./netem-harness.ts";
import {
  firstFrame,
  masterEvents,
  observeStart,
  observeStats,
  pageSigner,
} from "./observe-harness.ts";
import { quantiles } from "./proc-usage.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, fields, openLinked, provision } from "./trust-harness.ts";
import { BLUE, masterShows, op, visualStats, writeEvidence } from "./visual-harness.ts";

/*
 * W6.11 and W6.04's transport side (W6-PLAN.md slice E), behind RECNRUN_W6_BENCH=1: netem on the
 * interface the WebRTC path really crosses, while a job runs and the master watches it LIVE.
 */

test.skip(process.env.RECNRUN_W6_BENCH !== "1", "W6.E bench cells run with RECNRUN_W6_BENCH=1");
test.describe.configure({ mode: "serial" });

const CAP = 262_144;
const BASELINE_MS = 2_000;
const RECOVERY_MS = 6_000;

interface Case {
  name: string;
  netem: string[] | null;
  ms: number;
}

const CASES: Case[] = [
  { name: "loss-5%", netem: ["loss", "5%"], ms: 8_000 },
  { name: "jitter-50ms±20ms", netem: ["delay", "50ms", "20ms"], ms: 8_000 },
  { name: "delay-200ms", netem: ["delay", "200ms"], ms: 8_000 },
  { name: "outage-10s", netem: ["loss", "100%"], ms: 10_000 },
  { name: "saturated-receiver", netem: null, ms: 8_000 },
];

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
  key: Signer;
  dev: string;
  results: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W6.11 setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  const page = await openLinked(master, site.origin, worker);
  const key = await pageSigner(page);
  await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
  shared = { site, target, master, worker, page, root, key, dev: "", results: {} };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await writeEvidence("w6-netem.json", { chrome: c.master.version, dev: c.dev, ...c.results });
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("W6.11 path: 100% UDP loss on lo cuts the link, on eth0 it does not", async () => {
  const c = cell();
  const cut: Record<string, boolean> = {};
  for (const dev of ["eth0", "lo"]) {
    expect(await pingWithin(c.page, 5_000)).not.toBeNull();
    try {
      await impairUdp(dev, ["loss", "100%"]);
      cut[dev] = (await pingWithin(c.page, 3_000)) === null;
    } finally {
      await restore(dev);
    }
    await until(
      () => pingWithin(c.page, 5_000),
      (ms) => ms !== null,
      30_000,
    );
  }
  expect(cut).toEqual({ eth0: false, lo: true });
  c.dev = "lo";
  c.results.path = cut;
});

/** A job on the slow fixture page (blue panel), observed LIVE; answers its id. */
async function observedJob(c: Cell, holdMs: number) {
  const origin = c.target.origin;
  const base = fields(origin);
  const ops = [
    op("navigate", { url: `${origin}/visual/late?ms=${holdMs}` }),
    // The worker caps an op at 30 s.
    op("wait", { selector: "#late", state: "attached" }, Math.min(holdMs + 5_000, 30_000)),
    ...jobOps(origin, base.jobId),
  ];
  const job = await c.key.sign({ ...base, ops });
  expect((await submitDirect(c.worker, job)).status).toBe("ACCEPTED");
  const firstOp = () => ledger(c.worker, base.jobId);
  await until(firstOp, (record) => record?.ops[0]?.state === "DONE", 15_000);
  expect(await observeStart(c.page, base.jobId, "live")).toMatchObject({ ok: true });
  await firstFrame(c.page);
  await masterShows(c.page, BLUE);
  return { jobId: base.jobId, ops };
}

const delta = (after: Record<string, number>, before: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]),
  );

/** What one window of samples says about buffer, cost, frames, and control. */
function windowOf(samples: Sample[], previous: Sample) {
  const last = samples.at(-1) ?? previous;
  const seconds = Math.max((last.t || 1) / 1_000, 0.5);
  const answered = samples.map((s) => s.pingMs).filter((ms) => ms !== null);
  const statuses = samples.map((s) => s.statusMs).filter((ms) => ms !== null);
  return {
    samples: samples.length,
    maxBuffered: Math.max(...samples.map((s) => s.buffered)),
    shownFps: Number(((last.shown - previous.shown) / seconds).toFixed(2)),
    // Single-message frames lost on an unreliable channel leave no partial frame to count.
    // A frame sent in the previous window may be shown in this one: the count never goes negative.
    lostFrames: Math.max(0, last.sent - previous.sent - (last.shown - previous.shown)),
    senderDrops: delta(last.senderDrops, previous.senderDrops),
    masterDrops: delta(last.masterDrops, previous.masterDrops),
    rssMiB: { from: previous.rssMiB, max: Math.max(...samples.map((s) => s.rssMiB)) },
    cpuSecondsPerSecond: Number(((last.cpuSeconds - previous.cpuSeconds) / seconds).toFixed(2)),
    pingMs: { ...quantiles(answered), unanswered: samples.length - answered.length },
    statusMs: { ...quantiles(statuses), unanswered: samples.length - statuses.length },
  };
}

async function impaired(c: Cell, kase: Case, jobId: string) {
  try {
    if (kase.netem) await impairUdp(c.dev, kase.netem);
    else await slowReceiver(c.page, kase.ms);
    return await sampleFor(c.page, c.worker, jobId, kase.ms);
  } finally {
    // The qdisc never outlives its case, whatever failed.
    await restore(c.dev);
  }
}

for (const kase of CASES) {
  test(`W6.11 ${kase.name}: bounded buffer, responsive control, the same job result`, async () => {
    const c = cell();
    expect(c.dev).toBe("lo");
    const startsBefore = (await visualStats(c.worker)).starts;
    const { accepted: acceptedBefore, ended: endedBefore } = await observeStats(c.worker);
    const { jobId, ops } = await observedJob(c, BASELINE_MS + kase.ms + RECOVERY_MS + 4_000);
    const before = await sampleFor(c.page, c.worker, jobId, BASELINE_MS);
    const during = await impaired(c, kase, jobId);
    const after = await sampleFor(c.page, c.worker, jobId, RECOVERY_MS);
    const job = await ended(c.worker, jobId);
    expect(job.ops.map((entry) => entry.state)).toEqual(ops.map(() => "DONE"));
    expect(c.target.count(jobId)).toBe(1);
    for (const sample of [...before, ...during, ...after])
      expect(sample.buffered).toBeLessThanOrEqual(CAP);
    expect(after.some((sample) => sample.pingMs !== null)).toBe(true);
    if (kase.name !== "outage-10s") expect(during.every((s) => s.pingMs !== null)).toBe(true);
    const baseline = before[0] as Sample;
    const windows = {
      baseline: windowOf(before, baseline),
      during: windowOf(during, before.at(-1) ?? baseline),
      after: windowOf(after, during.at(-1) ?? baseline),
    };
    c.results[kase.name] = {
      netem: kase.netem ?? "master main thread busy 90 of every 100 ms",
      ...windows,
      captureStarts: (await visualStats(c.worker)).starts - startsBefore,
      observeAccepted: (await observeStats(c.worker)).accepted - acceptedBefore,
      sessionsEnded: (await observeStats(c.worker)).ended
        .slice(endedBefore.length)
        .map((e) => e.reason),
      renewals: (await masterEvents(c.page)).renewals,
      job: job.state,
      posts: c.target.count(jobId),
    };
    // Delivery holds through a fault and comes back after one, by a fresh start if the lease lapsed.
    if (kase.name !== "outage-10s") expect(windows.during.shownFps).toBeGreaterThan(0);
    expect(windows.after.shownFps).toBeGreaterThan(0);
    await call(c.page, "observeStop", NAME).catch(() => undefined);
    await settle(c.worker);
  });
}

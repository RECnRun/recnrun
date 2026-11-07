import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { call } from "./lifecycle-harness.ts";
import { observeStats } from "./observe-harness.ts";
import { quantiles, treeUsage } from "./proc-usage.ts";
import type { Usage } from "./proc-usage.ts";

/* W6.E scale and cost readouts: one window of frames, bytes, drops, latency, and /proc cost. */

interface Arrival {
  frameSeq: number;
  at: number;
  capturedAtMs: number;
}

interface Shown {
  frames: number;
  drops: Record<string, number>;
  arrivals: Arrival[];
}

interface Snapshot {
  at: number;
  wall: number;
  shown: Shown;
  gates: { bytes: number; sent: number; drops: Record<string, number> }[];
  workers: Usage[];
  master: Usage;
}

async function snapshot(page: Page, master: LaunchedChrome, workers: LoadedExtension[]) {
  const gates = [];
  for (const worker of workers) gates.push((await observeStats(worker)).gate);
  const snap: Snapshot = {
    at: performance.now(),
    wall: Date.now(),
    shown: await call<Shown>(page, "visualStats"),
    gates,
    workers: await Promise.all(workers.map((worker) => treeUsage(worker.chrome.pid))),
    master: await treeUsage(master.pid),
  };
  return snap;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function dropsDelta(after: Record<string, number>[], before: Record<string, number>[]) {
  const out: Record<string, number> = {};
  after.forEach((drops, index) => {
    for (const [reason, count] of Object.entries(drops)) {
      const change = count - (before[index]?.[reason] ?? 0);
      if (change) out[reason] = (out[reason] ?? 0) + change;
    }
  });
  return out;
}

const cpuPerSecond = (after: Usage, before: Usage | undefined, seconds: number) =>
  round((after.cpuSeconds - (before?.cpuSeconds ?? after.cpuSeconds)) / seconds);

function windowOf(before: Snapshot, after: Snapshot) {
  const seconds = (after.at - before.at) / 1_000;
  const fresh = after.shown.arrivals.filter((entry) => entry.at > before.wall);
  const frames = after.shown.frames - before.shown.frames;
  return {
    seconds: round(seconds, 1),
    shownFpsPerWorker: round(frames / seconds / Math.max(after.workers.length, 1)),
    bytesPerSecond: Math.round(
      (sum(after.gates.map((gate) => gate.bytes)) - sum(before.gates.map((gate) => gate.bytes))) /
        seconds,
    ),
    // Wall clock on both ends: worker and master run in one container, on one clock.
    captureToDisplayMs: quantiles(fresh.map((entry) => entry.at - entry.capturedAtMs)),
    senderDrops: dropsDelta(
      after.gates.map((gate) => gate.drops),
      before.gates.map((gate) => gate.drops),
    ),
    masterDrops: dropsDelta([after.shown.drops], [before.shown.drops]),
    workerCpuPerSecond: after.workers.map((usage, i) =>
      cpuPerSecond(usage, before.workers[i], seconds),
    ),
    workerRssMiB: after.workers.map((usage) => usage.rssMiB),
    masterCpuPerSecond: cpuPerSecond(after.master, before.master, seconds),
    masterRssMiB: after.master.rssMiB,
  };
}

export type Window = ReturnType<typeof windowOf>;

/** Frames, bytes, drops, display latency, and CPU/RSS of every browser tree over `ms`. */
export async function measure(
  page: Page,
  master: LaunchedChrome,
  workers: LoadedExtension[],
  ms: number,
): Promise<Window> {
  const before = await snapshot(page, master, workers);
  await delay(ms);
  return windowOf(before, await snapshot(page, master, workers));
}

interface VisibilityLog {
  __visibility?: { at: number; state: string }[];
}

// The renderer learns of the detach and the tab switch asynchronously.
const SETTLE_MS = 1_000;

/**
 * The same window with Playwright disconnected from the master: its focus emulation holds every
 * page it attaches "visible", so a background tab is hidden only while nothing is attached.
 */
export async function measureDetached(
  page: Page,
  master: LaunchedChrome,
  workers: LoadedExtension[],
  ms: number,
): Promise<{ window: Window; browser: Browser; page: Page; visibility: string[] }> {
  const origin = new URL(page.url()).origin;
  await page.evaluate(() => {
    const log: { at: number; state: string }[] = [];
    (globalThis as VisibilityLog).__visibility = log;
    setInterval(() => log.push({ at: Date.now(), state: document.visibilityState }), 500);
  });
  const before = await snapshot(page, master, workers);
  // A connected browser only disconnects; the default context and its tabs stay.
  await page.context().browser()?.close();
  const detachedAt = Date.now();
  await delay(ms);
  const browser = await chromium.connectOverCDP(master.wsEndpoint);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const again = pages.find((candidate) => candidate.url().startsWith(origin));
  if (!again) throw new Error("the master page is gone after the detached window");
  const after = await snapshot(again, master, workers);
  const log = await again.evaluate(() => (globalThis as VisibilityLog).__visibility ?? []);
  const visibility = log
    .filter((entry) => entry.at > detachedAt + SETTLE_MS && entry.at < detachedAt + ms)
    .map((entry) => entry.state);
  return { window: windowOf(before, after), browser, page: again, visibility };
}

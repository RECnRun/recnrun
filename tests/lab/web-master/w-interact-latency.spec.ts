import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { aimable, letterbox, tabState } from "./interact-click-harness.ts";
import type { Point, SentFrame } from "./interact-click-harness.ts";
import { centreOf, layoutOf, reports } from "./interact-drag-harness.ts";
import { interactStart, released, stopInteract } from "./interact-harness.ts";
import { call, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import { pageSigner } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, openLinked, provision } from "./trust-harness.ts";
import { visual, writeEvidence } from "./visual-harness.ts";

/*
 * Slice D of docs/poc/thin-worker/W7-PLAN.md: a press's reply and its first presented frame, timed
 * on the master's clock (30 samples per mode with RECNRUN_W7_BENCH=1, 3 otherwise), and N8:
 * input.v1 stays ordered, applied once, and prompt while padded frames saturate visual.v1.
 */

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
}

interface Click {
  ok: boolean;
  ackMs: number;
  visibleMs: number | null;
}

interface Strip {
  block: Point;
  cells: Point[];
}

interface Transport {
  maxBuffered: number;
  buffered: number;
  drops: Record<string, number>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W7.D latency setup did not run.");
  return shared;
};
const mode = () => test.info().project.name;
const SAMPLES = process.env.RECNRUN_W7_BENCH === "1" ? 30 : 3;
const CLICKS = 20;
// The burst's copies: 150 KB each, as W6.B 2 sends, to fill the 256 KiB buffer.
const PAD_BYTES = 150_000;

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id, mode() === "headless-worker");
  const page = await openLinked(master, site.origin, worker);
  const key = await pageSigner(page);
  const allowlist = [target.origin];
  await provision(worker, { masterKey: key.publicKey, allowlist, interactEnabled: true });
  shared = { site, target, master, worker, page, root };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe.configure({ mode: "serial" });

const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Number((sorted[Math.floor(q * (sorted.length - 1))] ?? 0).toFixed(1));
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};
const rounded = (values: number[]) => values.map((value) => Number(value.toFixed(1)));

const BITS = 8;

/** A lease on the latency page, observed live; answers the block's and the id cells' centres. */
async function begin(c: Cell): Promise<Strip> {
  const since = Date.now();
  const started = await interactStart(c.page, `${c.target.origin}/interact/latency`);
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  expect(await call(c.page, "interactObserve", NAME)).toMatchObject({ ok: true });
  await letterbox(c.page);
  await aimable(c.page);
  // The clicks aim at the frame announced on input.v1, which a new lease starts without.
  await until(
    () => call<SentFrame | null>(c.page, "interactAimable", NAME),
    (f) => Boolean(f?.geometry),
    10_000,
  );
  const layout = await layoutOf(c.target, "/interact/latency", since);
  const cells = Array.from({ length: BITS }, (_, bit) => centreOf(layout, `b${bit}`));
  return { block: centreOf(layout, "block"), cells };
}

/** One press; `id`, the press count the page draws in its cells, null to time the reply only. */
const click = (c: Cell, strip: Strip, id: number | null) =>
  call<Click>(
    c.page,
    "latencyClick",
    NAME,
    strip.block,
    id === null ? null : { id, cells: strip.cells },
  );
const presses = (c: Cell, since: number) =>
  reports(c.target, "press", since).map((report) => report.n as number);

test("latency: a press's reply and its first painted frame, on the master's clock", async () => {
  const c = cell();
  const strip = await begin(c);
  const since = Date.now();
  const ack: number[] = [];
  const visible: number[] = [];
  for (let n = 1; n <= SAMPLES; n += 1) {
    // The page draws each press's count in binary cells; the master decodes it from the frame
    // the image presents, and times that presentation.
    const sample = await click(c, strip, n);
    expect(sample.ok, JSON.stringify(sample)).toBe(true);
    expect(sample.visibleMs, `sample ${n} was never presented`).not.toBeNull();
    ack.push(sample.ackMs);
    visible.push(sample.visibleMs ?? 0);
    await expect.poll(() => presses(c, since).length).toBe(n);
    // Apart, so one sample's frames never answer the next.
    await delay(150);
  }
  expect(presses(c, since)).toEqual(Array.from({ length: SAMPLES }, (_, i) => i + 1));
  const result = { mode: mode(), ack: summary(ack), visible: summary(visible) };
  await writeEvidence(`w7-latency-${mode()}`, {
    ...result,
    raw: { ack: rounded(ack), visible: rounded(visible) },
  });
  console.log(`W7.D latency ${JSON.stringify(result)}`);
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
});

/** Bursts of padded copies on visual.v1 until `stop()`; resolves with how many it sent. */
function flood(c: Cell) {
  const state = { on: true, bursts: 0 };
  const running = (async () => {
    while (state.on) {
      const burst = await visual<{ ok: boolean }>(c.worker, "burst", 10, PAD_BYTES);
      expect(burst.ok).toBe(true);
      state.bursts += 1;
    }
  })();
  return {
    stop: async () => {
      state.on = false;
      await running;
      return state.bursts;
    },
  };
}

test("N8: input.v1 stays ordered, applied once, and prompt while visual.v1 is saturated", async () => {
  const c = cell();
  const strip = await begin(c);
  const before = await visual<Transport>(c.worker, "transport");
  const { dispatched } = (await tabState(c.worker)).stats;
  const since = Date.now();
  const flooding = flood(c);
  await delay(300);
  const buffered: number[] = [];
  const ack: number[] = [];
  for (let n = 1; n <= CLICKS; n += 1) {
    const sample = await click(c, strip, null);
    expect(sample.ok, JSON.stringify(sample)).toBe(true);
    ack.push(sample.ackMs);
    buffered.push((await visual<Transport>(c.worker, "transport")).buffered);
  }
  const bursts = await flooding.stop();
  await delay(500);
  const after = await visual<Transport>(c.worker, "transport");
  expect(presses(c, since)).toEqual(Array.from({ length: CLICKS }, (_, i) => i + 1));
  expect((await tabState(c.worker)).stats.dispatched - dispatched).toBe(CLICKS * 2);
  const replaced = (after.drops.replaced ?? 0) - (before.drops.replaced ?? 0);
  const result = {
    mode: mode(),
    ack: summary(ack),
    bursts,
    replaced,
    maxBuffered: after.maxBuffered,
  };
  await writeEvidence(`w7-n8-${mode()}`, { ...result, buffered, raw: rounded(ack) });
  console.log(`W7.D N8 ${JSON.stringify({ ...result, buffered: summary(buffered) })}`);
  // Saturated: the sender held more than its low mark and replaced frames it could not send.
  expect(Math.max(...buffered)).toBeGreaterThan(65_536);
  expect(replaced).toBeGreaterThan(0);
  expect(after.maxBuffered).toBeLessThanOrEqual(262_144);
  // A reply inside the dead man's second keeps a held press held through the congestion.
  expect(summary(ack).p95).toBeLessThan(1_000);
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
});

import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended, settle, signer, submitDirect } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import { background, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { fields, provision } from "./trust-harness.ts";
import {
  BLUE,
  GRAY,
  GREEN,
  ORANGE,
  frames,
  holdAt,
  panelShows,
  rate,
  reached,
  saveFrame,
  visual,
  visualOps,
  visualStats,
  writeEvidence,
} from "./visual-harness.ts";
import type { VisualStats } from "./visual-harness.ts";

/*
 * Slice A of docs/poc/thin-worker/W6-PLAN.md (Gates G0, G1): capture.js drives the job tab's
 * pixels over the runner's own chrome.debugger debuggee. No page-level client attaches to the
 * worker root; every readout goes through lab.visual on its service worker.
 */

const headless = () => test.info().project.name === "headless-worker";

interface Cell {
  target: Target;
  worker: LoadedExtension;
  root: string;
  key: Signer;
  jobId?: string;
  evidence: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W6.A setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const target = await startTarget();
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id, headless());
  const key = await signer();
  await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
  const evidence = { headless: headless(), workerFlags: worker.chrome.flags };
  shared = { target, worker, root, key, evidence };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await writeEvidence(`w-visual-${test.info().project.name}.json`, c.evidence);
  await c.worker.close().catch(() => undefined);
  await c.target.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe.configure({ mode: "serial" });

async function startJob(c: Cell, holdIndex: number) {
  await holdAt(c.worker, holdIndex);
  const job = await c.key.sign(fields(c.target.origin, { ops: visualOps(c.target.origin) }));
  const reply = await submitDirect(c.worker, job);
  expect(reply.status).toBe("ACCEPTED");
  c.jobId = String(job.jobId);
  await reached(c.worker, holdIndex);
}

/** Moves the runner's hold from where it is to `next`, then waits until it gets there. */
async function advance(c: Cell, next: number, phase = "between") {
  await holdAt(c.worker, next, phase);
  expect(await background<boolean>(c.worker, "lab.release()")).toBe(true);
  await reached(c.worker, next, phase);
}

test("W6.A 1: frames from the worker's own debuggee change after the job's click", async () => {
  const c = cell();
  expect(await visual(c.worker, "start", { mode: "thumbnail" })).toEqual({ ok: true });
  await startJob(c, 2);
  await panelShows(c.worker, BLUE);
  await saveFrame(c.worker, `${test.info().project.name}-before-click.jpg`);
  const thumbnail = await rate(c.worker);
  await visual(c.worker, "start", { mode: "live" });
  await panelShows(c.worker, BLUE);
  const live = await rate(c.worker);
  await advance(c, 4);
  await panelShows(c.worker, ORANGE);
  await saveFrame(c.worker, `${test.info().project.name}-after-click.jpg`);
  const stats = await visualStats(c.worker);
  expect(stats.state).toBe("ACTIVE");
  expect(stats.produced).toBeGreaterThan(0);
  expect(stats.acked).toBe(stats.produced);
  expect(stats.screenshots).toBeGreaterThan(0);
  expect(thumbnail.fps).toBeGreaterThan(0);
  expect(live.fps).toBeGreaterThan(0);
  c.evidence.click = { thumbnail, live, visibility: stats.visibility, errors: stats.errors };
});

test("W6.A 2: a navigation starts a new epoch and keeps no frame of the old one", async () => {
  const c = cell();
  const before = await visualStats(c.worker);
  await advance(c, 6);
  await panelShows(c.worker, GREEN);
  const stats = await visualStats(c.worker);
  expect(stats.epoch).toBeGreaterThan(before.epoch);
  const second = stats.epochs.find((entry) => entry.url.endsWith("/visual/second"));
  expect(second).toBeDefined();
  // No frame logged under an epoch was captured before that epoch's document committed.
  for (const entry of frames(stats)) {
    const start = stats.epochs.find((epoch) => epoch.epoch === entry.epoch)?.at ?? 0;
    expect(entry.capturedAtMs ?? 0).toBeGreaterThanOrEqual(start);
  }
  const epochs = frames(stats).map((entry) => entry.epoch);
  expect(epochs).toEqual([...epochs].sort((a, b) => a - b));
  c.evidence.navigation = { epochs: stats.epochs, drops: stats.drops };
});

test("W6.A 3: a static page gives a first screenshot, then NO_CHANGE heartbeats", async () => {
  const c = cell();
  await visual(c.worker, "stop");
  await advance(c, 7, "afterEffect");
  const before = await visualStats(c.worker);
  const startedAt = Date.now();
  await visual(c.worker, "start", { mode: "thumbnail" });
  await panelShows(c.worker, GRAY);
  await delay(3_500);
  const stats = await visualStats(c.worker);
  const fresh = stats.log.filter((entry) => entry.at > (before.log.at(-1)?.at ?? 0));
  const images = fresh.filter((entry) => entry.type === "frame");
  expect(images.some((entry) => entry.source === "screenshot")).toBe(true);
  const beats = fresh.filter((entry) => entry.type === "NO_CHANGE");
  expect(beats.length).toBeGreaterThanOrEqual(2);
  const screencast = stats.produced - before.produced;
  await background(c.worker, "lab.setKnob(null)");
  await background(c.worker, "lab.release()");
  const job = await ended(c.worker, c.jobId ?? "");
  // Capture changed nothing the job did: every op is DONE, as with no capture.
  expect([job.state, ...job.ops.map((entry) => entry.state)]).toEqual(Array(9).fill("DONE"));
  expect((await visualStats(c.worker)).state).toBe("ENDED");
  const sources = images.map((entry) => entry.source);
  const firstImageMs = (images[0]?.at ?? 0) - startedAt;
  c.evidence.static = {
    screencastFrames: screencast,
    heartbeats: beats.length,
    sources,
    firstImageMs,
  };
});

test("W6.A 4: a background tab draws frames with and without focus emulation", async () => {
  const c = cell();
  await settle(c.worker);
  const url = `${c.target.origin}/visual`;
  const focused = await visual<{ frames: number }>(c.worker, "probeBackground", url, true, 2_000);
  const unfocused = await visual<{ frames: number }>(
    c.worker,
    "probeBackground",
    url,
    false,
    2_000,
  );
  c.evidence.background = { focused, unfocused };
  expect(focused.frames).toBeGreaterThan(0);
});

async function faulted(c: Cell, kind: string): Promise<VisualStats> {
  await settle(c.worker);
  await startJob(c, 2);
  await panelShows(c.worker, BLUE);
  const { starts } = await visualStats(c.worker);
  await visual(c.worker, "fault", kind);
  const stats = await until(
    () => visualStats(c.worker),
    (value) => value.detached !== null,
    15_000,
  );
  await delay(2_000);
  const later = await visualStats(c.worker);
  // Reported once and left alone: no new start, no frame after the detach.
  expect(later.starts).toBe(starts);
  expect(later.produced).toBe(stats.produced);
  await background(c.worker, "lab.setKnob(null)");
  await background(c.worker, "lab.release()");
  const job = await ended(c.worker, c.jobId ?? "");
  return { ...later, state: `${later.state}/${job.state}` };
}

test("W6.A 5: a closed tab and a detached debugger are reported, not retried", async () => {
  const c = cell();
  await visual(c.worker, "start", { mode: "thumbnail" });
  const closed = await faulted(c, "close-tab");
  expect(closed.state.startsWith("DETACHED")).toBe(true);
  const left = await faulted(c, "chrome-url");
  expect(left.state.startsWith("DETACHED")).toBe(true);
  await visual(c.worker, "stop");
  c.evidence.faults = {
    closeTab: { detached: closed.detached, state: closed.state },
    chromeUrl: { detached: left.detached, state: left.state },
  };
});

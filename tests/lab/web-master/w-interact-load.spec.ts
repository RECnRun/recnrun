import { rm } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ledger } from "./admission-harness.ts";
import { framesSent } from "./interact-click-harness.ts";
import { released, stopInteract } from "./interact-harness.ts";
import { begin, rounded, sampleClicks, summary } from "./latency-harness.ts";
import { call, link, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import { observeStats, pageSigner } from "./observe-harness.ts";
import { treeUsage } from "./proc-usage.ts";
import type { Usage } from "./proc-usage.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { fields, openLinked, provision } from "./trust-harness.ts";
import { op, writeEvidence } from "./visual-harness.ts";

/*
 * W7 load cell, behind RECNRUN_W7_BENCH=1: the owner presses on one interactive worker alone,
 * then with two more workers of the same master streaming THUMBNAIL (1 fps, 480×270) of a job
 * tab that keeps changing. Latency, INTERACT fps, and the CPU and RSS of every browser tree.
 */

test.skip(process.env.RECNRUN_W7_BENCH !== "1", "W7 load cells run with RECNRUN_W7_BENCH=1");
test.describe.configure({ mode: "serial" });

const SAMPLES = 30;
// The thumbnail jobs hold their spinning page longer than the loaded scenario takes.
const LEG_MS = 25_000;
const THUMBS = ["t1", "t2"];

interface Thumb {
  name: string;
  root: string;
  worker: LoadedExtension;
}

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
  masterKey: JsonWebKey;
  thumbs: Thumb[];
  results: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W7 load setup did not run.");
  return shared;
};
const mode = () => test.info().project.name;
const headless = () => mode() === "headless-worker";

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id, headless());
  const page = await openLinked(master, site.origin, worker);
  const { publicKey: masterKey } = await pageSigner(page);
  const allowlist = [target.origin];
  await provision(worker, { masterKey, allowlist, interactEnabled: true });
  shared = { site, target, master, worker, page, root, masterKey, thumbs: [], results: {} };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await writeEvidence(`w7-load-${mode()}`, { chrome: c.master.version, ...c.results });
  for (const { worker, root } of c.thumbs) {
    await worker.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A linked worker on a held job of the spinning page, observed from its card's Observe. */
async function addThumb(c: Cell, name: string): Promise<Thumb> {
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id, headless());
  await provision(worker, { masterKey: c.masterKey, allowlist: [c.target.origin] });
  expect(await link(c.page, worker, name)).toBe(true);
  const { jobId } = fields(c.target.origin);
  // An op waits 30 s at most: the spinning page is held in two legs.
  const ops = [0, 1].flatMap(() => [
    op("navigate", { url: `${c.target.origin}/visual/late?ms=${LEG_MS}` }),
    op("wait", { selector: "#late", state: "attached" }, LEG_MS + 5_000),
  ]);
  const job = { jobId, origins: [c.target.origin], ops };
  expect(await call(c.page, "submit", name, job)).toMatchObject({ status: "ACCEPTED" });
  await until(
    () => ledger(worker, jobId),
    (record) => record?.ops[0]?.state === "DONE",
    15_000,
  );
  await call(c.page, "dashboardAdd", name, jobId);
  const card = c.page.getByRole("listitem").filter({ hasText: `${name} · ` });
  await card.getByRole("button", { name: "Observe" }).click();
  await until(
    () => observeStats(worker),
    (stats) => stats.session?.mode === "thumbnail",
    10_000,
  );
  return { name, root, worker };
}

interface Snapshot {
  at: number;
  interactive: Usage;
  thumbs: Usage[];
  master: Usage;
  interactFrames: number;
  thumbFrames: number[];
  shownBy: Record<string, number>;
}

async function snapshot(c: Cell): Promise<Snapshot> {
  const thumbFrames = [];
  for (const thumb of c.thumbs) thumbFrames.push((await observeStats(thumb.worker)).gate.sent);
  const { shownBy } = await call<{ shownBy: Record<string, number> }>(c.page, "visualStats");
  return {
    at: performance.now(),
    interactive: await treeUsage(c.worker.chrome.pid),
    thumbs: await Promise.all(c.thumbs.map((thumb) => treeUsage(thumb.worker.chrome.pid))),
    master: await treeUsage(c.master.pid),
    interactFrames: await framesSent(c.worker),
    thumbFrames,
    shownBy,
  };
}

const round = (value: number) => Number(value.toFixed(2));
const cost = (after: Usage, before: Usage | undefined, seconds: number) => ({
  cpuPerSecond: round((after.cpuSeconds - (before?.cpuSeconds ?? after.cpuSeconds)) / seconds),
  rssMiB: after.rssMiB,
});

function windowOf(c: Cell, before: Snapshot, after: Snapshot) {
  const seconds = (after.at - before.at) / 1_000;
  return {
    seconds: round(seconds),
    interactFps: round((after.interactFrames - before.interactFrames) / seconds),
    thumbnailFps: after.thumbFrames.map((n, i) =>
      round((n - (before.thumbFrames[i] ?? 0)) / seconds),
    ),
    // Frames of the thumbnail workers that the large interactive image showed.
    imageFramesFromThumbs: c.thumbs.map(
      ({ name }) => (after.shownBy[name] ?? 0) - (before.shownBy[name] ?? 0),
    ),
    interactive: cost(after.interactive, before.interactive, seconds),
    thumbs: after.thumbs.map((usage, i) => cost(usage, before.thumbs[i], seconds)),
    master: cost(after.master, before.master, seconds),
  };
}

/** 30 presses on the interactive worker, with the window's frames and /proc cost. */
async function scenario(c: Cell) {
  const strip = await begin(c);
  const before = await snapshot(c);
  const { ack, visible } = await sampleClicks(c, strip, SAMPLES);
  const window = windowOf(c, before, await snapshot(c));
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
  await call(c.page, "interactDetach");
  return { ack: summary(ack), visible: summary(visible), ...window, raw: rounded(visible) };
}

type Result = Awaited<ReturnType<typeof scenario>>;

// Acceptable: thumbnails cost the interactive view under one 60 Hz frame at p95, and under a
// tenth of its INTERACT frame rate.
const FRAME_MS = 1_000 / 60;
const verdictOf = (alone: Result, loaded: Result) => {
  const visibleP95DeltaMs = round(loaded.visible.p95 - alone.visible.p95);
  const ackP95DeltaMs = round(loaded.ack.p95 - alone.ack.p95);
  const fpsDelta = round(loaded.interactFps - alone.interactFps);
  const ok = visibleP95DeltaMs < FRAME_MS && fpsDelta > -alone.interactFps / 10;
  const verdict = ok ? "thumbnails acceptable" : "fall back to the interactive worker alone";
  return { visibleP95DeltaMs, ackP95DeltaMs, fpsDelta, verdict };
};

test("load alone: one interactive worker, no other worker", async () => {
  const c = cell();
  const alone = await scenario(c);
  c.results.alone = alone;
  console.log(`W7 load alone ${JSON.stringify({ ...alone, raw: undefined })}`);
});

test("load with-thumbnails: two more workers stream THUMBNAIL beside the interactive one", async () => {
  const c = cell();
  // The letterboxed image covers the cards; it is laid out again when the lease begins.
  await c.page.evaluate(() => document.getElementById("visual")?.removeAttribute("style"));
  for (const name of THUMBS) c.thumbs.push(await addThumb(c, name));
  const loaded = await scenario(c);
  c.results["with-thumbnails"] = loaded;
  const delta = c.results.alone ? verdictOf(c.results.alone as Result, loaded) : null;
  c.results.delta = delta;
  console.log(`W7 load with-thumbnails ${JSON.stringify({ ...loaded, raw: undefined, delta })}`);
  for (const fps of loaded.thumbnailFps) {
    expect(fps).toBeGreaterThan(0);
    expect(fps).toBeLessThanOrEqual(1.2);
  }
  // The owner's interactive view shows the interactive worker alone; thumbnails stay in cards.
  expect(loaded.imageFramesFromThumbs).toEqual(THUMBS.map(() => 0));
});

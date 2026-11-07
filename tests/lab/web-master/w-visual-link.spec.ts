import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { settle, signer } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import { background, call, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, openLinked, provision } from "./trust-harness.ts";
import {
  BLUE,
  ORANGE,
  advance,
  masterShows,
  startVisualJob,
  visual,
  writeEvidence,
} from "./visual-harness.ts";

/*
 * Slice B of docs/poc/thin-worker/W6-PLAN.md (Gate G2): frames go service worker → offscreen
 * (chrome.runtime) → visual.v1, a second unordered channel on the link's peer connection, and the
 * master page reassembles and shows them. The recnrun-lab channel keeps answering meanwhile.
 */

const CAP = 262_144;

interface MasterStats {
  frames: number;
  drops: Record<string, number>;
  workers: { url: string; epoch: number; frameSeq: number }[];
  revoked: number;
  arrivals: { frameSeq: number; at: number }[];
  size: [number, number];
}

interface TransportStats {
  offered: number;
  sent: number;
  messages: number;
  maxBuffered: number;
  rejected: number;
  drops: { replaced: number; oversize: number; closed: number; invalid: number };
  relayMs: number[];
  handoffs: { frameSeq: number; at: number }[];
  base64Ms: number[];
  messageMax: number;
  lastError: string;
}

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
  key: Signer;
  jobId: string;
  evidence: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W6.B setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  const page = await openLinked(master, site.origin, worker);
  const key = await signer();
  await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
  const evidence = { chrome: master.version, workerFlags: worker.chrome.flags };
  shared = { site, target, master, worker, page, root, key, jobId: "", evidence };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await writeEvidence("w-visual-link.json", c.evidence);
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe.configure({ mode: "serial" });

const masterStats = (c: Cell) => call<MasterStats>(c.page, "visualStats");
const transport = (c: Cell) => visual<TransportStats>(c.worker, "transport");

const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Number((sorted[Math.floor(q * (sorted.length - 1))] ?? 0).toFixed(2));
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};

/** Service worker handoff to master arrival, per frame both sides logged (one container clock). */
const swToMaster = (sent: TransportStats, shown: MasterStats) => {
  const handoff = new Map(sent.handoffs.map((entry) => [entry.frameSeq, entry.at]));
  const pairs = shown.arrivals.filter((entry) => handoff.has(entry.frameSeq));
  return summary(pairs.map((entry) => entry.at - (handoff.get(entry.frameSeq) ?? 0)));
};

/** Frames per second the capture produced and the master showed over `ms`. */
async function delivered(c: Cell, ms = 2_000) {
  const produced = () => visual<{ produced: number }>(c.worker, "stats");
  const [capture, master] = [await produced(), await masterStats(c)];
  await delay(ms);
  const [capture2, master2] = [await produced(), await masterStats(c)];
  const perSecond = (n: number) => Number(((n * 1_000) / ms).toFixed(1));
  return {
    capturedFps: perSecond(capture2.produced - capture.produced),
    shownFps: perSecond(master2.frames - master.frames),
  };
}

/** Twenty pings and one job-status round trip on recnrun-lab while frames flow. */
async function control(c: Cell) {
  const pingMs = await call<number>(c.page, "ping", NAME, 20);
  const started = Date.now();
  const status = await call<{ jobs: { state: string }[] }>(c.page, "jobStatus", NAME, [c.jobId]);
  return { pingMs, statusMs: Date.now() - started, state: status.jobs[0]?.state };
}

test("W6.B 1: the master shows the worker's frames, which change after the click", async () => {
  const c = cell();
  c.jobId = await startVisualJob(c.worker, c.key, c.target.origin, 2);
  expect(await call(c.page, "visualStart", NAME, "live")).toMatchObject({ ok: true });
  await masterShows(c.page, BLUE);
  const during = await control(c);
  expect(during.state).toBe("RUNNING");
  // Twenty round trips in under 2 s while the screencast streams.
  expect(during.pingMs).toBeLessThan(2_000);
  await advance(c.worker, 4);
  await masterShows(c.page, ORANGE);
  const rate = await delivered(c);
  const stats = await masterStats(c);
  const sent = await transport(c);
  expect(stats.frames).toBeGreaterThan(1);
  expect(stats.workers).toHaveLength(1);
  expect(stats.revoked).toBe(stats.frames - 1);
  expect(sent.messageMax).toBe(16_384);
  expect(sent.drops.invalid).toBe(0);
  c.evidence.click = {
    control: during,
    frames: stats.frames,
    masterDrops: stats.drops,
    size: stats.size,
    rate,
    swToMasterMs: swToMaster(sent, stats),
    swToOffscreenMs: summary(sent.relayMs),
    base64Ms: summary(sent.base64Ms),
    transport: { sent: sent.sent, messages: sent.messages, drops: sent.drops },
  };
});

test("W6.B 2: a burst keeps the buffer under 256 KiB and counts what it drops", async () => {
  const c = cell();
  const before = await transport(c);
  const shown = (await masterStats(c)).frames;
  const pinging = call<number>(c.page, "ping", NAME, 20);
  const burst = await visual<{ ok: boolean; frameBytes: number }>(c.worker, "burst", 40, 150_000);
  const oversize = await visual<{ ok: boolean }>(c.worker, "burst", 1, 300_000);
  expect(burst.ok && oversize.ok).toBe(true);
  const pingMs = await pinging;
  await until(
    () => masterStats(c),
    (stats) => stats.frames > shown + 1,
    15_000,
  );
  const after = await transport(c);
  expect(after.maxBuffered).toBeLessThanOrEqual(CAP);
  // All but the copy in flight and the one left in the slot are replaced.
  expect(after.drops.replaced - before.drops.replaced).toBeGreaterThanOrEqual(38);
  expect(after.drops.oversize - before.drops.oversize).toBeGreaterThanOrEqual(1);
  expect(pingMs).toBeLessThan(2_000);
  await masterShows(c.page, ORANGE);
  const stats = await masterStats(c);
  c.evidence.burst = {
    frameBytes: burst.frameBytes,
    maxBuffered: after.maxBuffered,
    drops: after.drops,
    pingMs,
    masterDrops: stats.drops,
  };
});

test("W6.B 3: visual.v1 carries no control: a ping or a job sent on it gets nothing", async () => {
  const c = cell();
  const before = await transport(c);
  const masterBefore = await masterStats(c);
  const jobs = await background<unknown[]>(c.worker, "lab.jobs()");
  const job = await c.key.sign({ jobId: crypto.randomUUID(), ops: [] });
  await call(c.page, "visualSendRaw", NAME, JSON.stringify({ type: "ping", sequence: 1 }));
  await call(c.page, "visualSendRaw", NAME, JSON.stringify({ type: "job", job }));
  await delay(1_000);
  const after = await transport(c);
  expect(after.rejected - before.rejected).toBe(2);
  expect(await background<unknown[]>(c.worker, "lab.jobs()")).toHaveLength(jobs.length);
  // Nothing came back as text on visual.v1: the receiver saw no malformed message.
  expect((await masterStats(c)).drops.malformed ?? 0).toBe(masterBefore.drops.malformed ?? 0);
  expect(await call(c.page, "visualStop", NAME)).toMatchObject({ ok: true });
  await background(c.worker, "lab.setKnob(null)");
  await background(c.worker, "lab.release()");
  await settle(c.worker);
  c.evidence.controlRefused = { rejected: after.rejected - before.rejected };
});

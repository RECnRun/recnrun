import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Locator, Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import type { JobOp } from "./lifecycle-harness.ts";
import {
  call,
  killWorker,
  link,
  provisionWorker,
  startWorker,
  until,
} from "./lifecycle-harness.ts";
import { letRun, masterStats, observeStats, pageSigner, startHeld } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { provision } from "./trust-harness.ts";
import {
  BLUE,
  GRAY,
  GREEN,
  cardShows,
  op,
  startVisualJob,
  visualOps,
  visual,
  writeEvidence,
} from "./visual-harness.ts";
import type { Rgb } from "./visual-harness.ts";

/*
 * Slice D of docs/poc/thin-worker/W6-PLAN.md (Gate G4): the site's dashboard of three worker
 * roots, observation off by default, a live viewer of one worker, and jobs observation never slows.
 */

const headless = () => test.info().project.name === "headless-worker";

interface Worker {
  name: string;
  root: string;
  worker: LoadedExtension;
  workerId: string;
  jobId: string;
}

interface Card {
  name: string;
  status: string;
  observation: string;
  stale: boolean;
  hasFrame: boolean;
  frameAgeMs: number | null;
  note: string;
}

interface Dashboard {
  cards: Card[];
  viewer: { open: boolean; card: Card | null; readout: string; trace: string };
}

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  page: Page;
  key: Signer;
  workers: Worker[];
  evidence: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W6.D setup did not run.");
  return shared;
};

// Held where each worker's job tab shows its own colour: the fixture, the second page, the static one.
const HOLDS: [number, Rgb][] = [
  [2, BLUE],
  [6, GREEN],
  [7, GRAY],
];

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const context = master.browser.contexts()[0] ?? (await master.browser.newContext());
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  await expect(page.locator("#status")).toHaveText("ready");
  const key = await pageSigner(page);
  const workers: Worker[] = [];
  for (const index of [0, 1, 2]) {
    const { root, id } = await provisionWorker();
    const worker = await startWorker(root, id, headless());
    await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
    const name = `w${index}`;
    expect(await link(page, worker, name)).toBe(true);
    workers.push({ name, root, worker, workerId: id, jobId: "" });
  }
  const evidence = { chrome: master.version, headless: headless() };
  shared = { site, target, master, page, key, workers, evidence };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await writeEvidence(`w-dashboard-${headless() ? "headless" : "headed"}.json`, c.evidence);
  for (const { worker, root } of c.workers) {
    await worker.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  await c.master.close();
  await c.target.close();
  await c.site.close();
});

test.describe.configure({ mode: "serial" });

const dashboard = (page: Page) => call<Dashboard>(page, "dashboardState");
const cardOf = async (page: Page, name: string) =>
  (await dashboard(page)).cards.find((card) => card.name === name);
const cardItem = (page: Page, w: Worker): Locator =>
  page.getByRole("listitem").filter({ hasText: `${w.name} · ` });
const press = (page: Page, w: Worker, label: string) =>
  cardItem(page, w).getByRole("button", { name: label }).click();
const cardIs = (page: Page, name: string, done: (card: Card) => boolean, ms = 15_000) =>
  until(
    async () => (await cardOf(page, name)) ?? null,
    (card) => card !== null && done(card),
    ms,
  );
const modeOf = async (w: Worker) => (await observeStats(w.worker)).session?.mode ?? "off";

test("W6.05: every card starts with observation off, no frame, and the privacy notice", async () => {
  const c = cell();
  for (const [index, w] of c.workers.entries()) {
    w.jobId = await startVisualJob(w.worker, c.key, c.target.origin, HOLDS[index]?.[0] ?? 2);
    await call(c.page, "dashboardAdd", w.name, w.jobId);
  }
  await expect(c.page.locator("#privacy")).toContainText("Observation is off by default");
  await delay(2_000);
  const { cards } = await dashboard(c.page);
  expect(cards.map((card) => [card.status, card.observation, card.hasFrame])).toEqual([
    ["RUNNING", "OFF", false],
    ["RUNNING", "OFF", false],
    ["RUNNING", "OFF", false],
  ]);
  expect((await masterStats(c.page)).frames).toBe(0);
  for (const w of c.workers) expect((await observeStats(w.worker)).gate.sent).toBe(0);
  await expect(cardItem(c.page, c.workers[0] as Worker)).toContainText("RUNNING · OFF · no frame");
});

test("W6.05, W6.08: Observe shows each worker's own colour, the static page included", async () => {
  const c = cell();
  const firstImageMs: Record<string, number> = {};
  for (const [index, w] of c.workers.entries()) {
    const started = Date.now();
    await press(c.page, w, "Observe");
    await cardShows(c.page, w.name, HOLDS[index]?.[1] ?? BLUE);
    firstImageMs[w.name] = Date.now() - started;
  }
  const { cards } = await dashboard(c.page);
  expect(cards.map((card) => card.observation)).toEqual(["THUMBNAIL", "THUMBNAIL", "THUMBNAIL"]);
  for (const w of c.workers) expect(await modeOf(w)).toBe("thumbnail");
  // The static page sends one screencast frame at most; its first image must still arrive.
  c.evidence.firstImageMs = firstImageMs;
});

test("W6.07: the viewer is live for one worker only and closing it returns a thumbnail", async () => {
  const c = cell();
  const [w0, w1, w2] = c.workers as [Worker, Worker, Worker];
  await press(c.page, w0, "Open viewer");
  await expect(c.page.getByRole("dialog")).toBeVisible();
  await until(
    () => modeOf(w0),
    (mode) => mode === "live",
    5_000,
  );
  expect([await modeOf(w1), await modeOf(w2)]).toEqual(["thumbnail", "thumbnail"]);
  const view = await until(
    () => dashboard(c.page),
    (value) => /latency -?\d+ ms · \d+ fps · drops \d+ · capture ACTIVE/.test(value.viewer.readout),
    10_000,
  );
  expect(view.viewer.trace).toBe("last action: op 1 wait DONE");
  expect(view.viewer.card?.observation).toBe("LIVE");
  c.evidence.viewer = view.viewer;
  await c.page.getByRole("button", { name: "Close" }).click();
  await until(
    () => modeOf(w0),
    (mode) => mode === "thumbnail",
    5_000,
  );
  expect((await cardOf(c.page, w0.name))?.observation).toBe("THUMBNAIL");
  await press(c.page, w0, "Open viewer");
  await until(
    () => modeOf(w0),
    (mode) => mode === "live",
    5_000,
  );
  await c.page.getByRole("button", { name: "Stop observing" }).click();
  await expect(c.page.getByRole("dialog")).toBeHidden();
  await until(
    () => modeOf(w0),
    (mode) => mode === "off",
    5_000,
  );
  expect((await cardOf(c.page, w0.name))?.observation).toBe("OFF");
});

test("W6.05: Pause keeps the last frame, ends the stream, and the card shows the job's end", async () => {
  const c = cell();
  const w1 = c.workers[1] as Worker;
  await press(c.page, w1, "Pause");
  await until(
    () => modeOf(w1),
    (mode) => mode === "off",
    5_000,
  );
  await delay(3_500);
  const paused = await cardOf(c.page, w1.name);
  expect(paused).toMatchObject({ observation: "PAUSED", stale: false, hasFrame: true });
  await cardShows(c.page, w1.name, GREEN, 1_000);
  await letRun(w1.worker);
  await ended(w1.worker, w1.jobId);
  await cardIs(c.page, w1.name, (card) => card.status === "DONE");
});

test("W6.05: a lost debugger marks the card STREAM_UNAVAILABLE", async () => {
  const c = cell();
  const w0 = c.workers[0] as Worker;
  await press(c.page, w0, "Observe");
  await cardIs(c.page, w0.name, (card) => card.observation === "THUMBNAIL");
  await visual(w0.worker, "fault", "chrome-url");
  const card = await cardIs(c.page, w0.name, (value) => value.status === "STREAM_UNAVAILABLE");
  expect(card?.observation).toBe("OFF");
  await letRun(w0.worker);
  await ended(w0.worker, w0.jobId);
});

/** The fixture, its click, then five slow documents: about 1.5 s of ops after the hold at op 2. */
const slowOps = (origin: string): JobOp[] => [
  ...visualOps(origin).slice(0, 4),
  ...Array.from({ length: 5 }, () => op("navigate", { url: `${origin}/visual/slow` })),
  op("wait", { selector: "#second", state: "attached" }),
];

/** Release to the ledger's end of a job held at op 2, observed through the viewer or not. */
async function sample(c: Cell, w: Worker, observed: boolean) {
  const jobId = await startHeld(w.worker, c.key, c.target.origin, () => slowOps(c.target.origin));
  await call(c.page, "dashboardAdd", w.name, jobId);
  if (observed) {
    await press(c.page, w, "Observe");
    await cardShows(c.page, w.name, BLUE);
  }
  const released = Date.now();
  await letRun(w.worker);
  const modes: string[] = [];
  if (observed) {
    await press(c.page, w, "Open viewer");
    await delay(500);
    modes.push(await modeOf(w));
    await c.page.getByRole("button", { name: "Close" }).click();
    await delay(300);
    modes.push(await modeOf(w));
  }
  const record = await ended(w.worker, jobId);
  expect(record.state).toBe("DONE");
  // The mode changed while the job still ran: both reads came before its end.
  if (observed) expect(modes).toEqual(["live", "thumbnail"]);
  return (record.endedAt ?? 0) - released;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;

test("W6.07: thumbnail to live to thumbnail does not slow the job", async () => {
  const c = cell();
  const w1 = c.workers[1] as Worker;
  const control: number[] = [];
  const observed: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    control.push(await sample(c, w1, false));
    observed.push(await sample(c, w1, true));
  }
  c.evidence.duration = { control, observed, delta: median(observed) - median(control) };
  // A job's ops never wait on a frame: observation adds no more than scheduling noise.
  expect(median(observed)).toBeLessThanOrEqual(median(control) * 1.5 + 250);
});

test("W6.05: a killed worker's card turns STALE, then DISCONNECTED", async () => {
  const c = cell();
  const w2 = c.workers[2] as Worker;
  expect((await cardOf(c.page, w2.name))?.observation).toBe("THUMBNAIL");
  const killedAt = Date.now();
  await killWorker(w2.worker);
  const stale = await cardIs(c.page, w2.name, (card) => card.stale, 10_000);
  const staleMs = Date.now() - killedAt;
  const gone = await cardIs(c.page, w2.name, (card) => card.status === "DISCONNECTED", 60_000);
  c.evidence.killed = { staleMs, disconnectedMs: Date.now() - killedAt, stale, gone };
});

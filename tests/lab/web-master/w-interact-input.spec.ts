import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { aimable, clickAt, letterbox, tabState } from "./interact-click-harness.ts";
import { interactStart, released, session, stopInteract } from "./interact-harness.ts";
import {
  aimKey,
  masterText,
  pressAt,
  releasedState,
  reportsOf,
  scrolled,
  wheelAt,
  workerText,
} from "./interact-input-harness.ts";
import { background, call, provisionWorker, startWorker } from "./lifecycle-harness.ts";
import { pageSigner } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, openLinked, provision } from "./trust-harness.ts";

/*
 * Slice C of docs/poc/thin-worker/W7-PLAN.md: keys from a closed table, typed text, wheels, and
 * held buttons and keys let go when the master stops sending, goes away, or loses the link.
 */

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W7.C setup did not run.");
  return shared;
};
const headless = () => test.info().project.name === "headless-worker";

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id, headless());
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

const FIELD = { x: 0.4, y: 0.375 };
const PAGE_AREA = { x: 0.25, y: 0.6 };
const INNER = { x: 0.75, y: 0.5 };
const MARKER = "RecnrunTypedMarker7Q";
const submits = (c: Cell) => reportsOf(c.target.reports, "submit");

/** A lease on a fixture page, observed live, with the image letterboxed. */
async function begin(c: Cell, path: string) {
  const started = await interactStart(c.page, `${c.target.origin}${path}`);
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  expect(await call(c.page, "interactObserve", NAME)).toMatchObject({ ok: true });
  await letterbox(c.page);
  return aimable(c.page);
}

async function end(c: Cell) {
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
}

/** Clicks the form's field, so the worker's page and the master's key capture both take keys. */
async function focusField(c: Cell) {
  const downs = reportsOf(c.target.reports, "mouseup").length;
  await clickAt(c.page, FIELD);
  await expect.poll(() => reportsOf(c.target.reports, "mouseup").length).toBe(downs + 1);
}

/** Holds the left button and ArrowDown over the field; answers when the page saw both. */
async function holdBoth(c: Cell) {
  await focusField(c);
  const downs = reportsOf(c.target.reports, "mousedown").length;
  await pressAt(c.page, FIELD);
  await c.page.keyboard.down("ArrowDown");
  const pressed = () => reportsOf(c.target.reports, "mousedown").length === downs + 1;
  const keyed = () => reportsOf(c.target.reports, "keydown").at(-1)?.key === "ArrowDown";
  await expect.poll(() => pressed() && keyed()).toBe(true);
}

/** Waits until the page saw the button and the key go up after `since`; answers the latency. */
async function letGo(c: Cell, since: number): Promise<number> {
  const ups = () => [
    reportsOf(c.target.reports, "mouseup", since).at(0),
    reportsOf(c.target.reports, "keyup", since).find((report) => report.key === "ArrowDown"),
  ];
  await expect.poll(() => ups().every(Boolean), { timeout: 2_500 }).toBe(true);
  return Math.max(...ups().map((report) => (report?.at ?? 0) - since));
}

/** A fresh master page on the same origin and key: a new start works after the cleanup. */
async function restart(c: Cell) {
  await c.page.close().catch(() => undefined);
  c.page = await openLinked(c.master, c.site.origin, c.worker);
  await begin(c, "/interact/form");
  await end(c);
}

const note = (type: string, description: string) => {
  test.info().annotations.push({ type, description });
  console.log(`W7.C ${type} ${description}`);
};

test("I2: typed text, Backspace, and Enter reach the field and submit it once", async () => {
  const c = cell();
  await begin(c, "/interact/form");
  await focusField(c);
  await c.page.keyboard.type("Olá ação 123");
  await c.page.keyboard.press("Backspace");
  await c.page.keyboard.press("Enter");
  await expect.poll(() => submits(c).at(-1)?.value).toBe("Olá ação 12");
  await delay(500);
  expect(submits(c)).toHaveLength(1);
  await end(c);
});

test("I3: a wheel scrolls the page, and over the inner container only the container", async () => {
  const c = cell();
  await begin(c, "/interact/scroll");
  await wheelAt(c.page, PAGE_AREA, 300);
  await expect.poll(() => scrolled(c.target.reports).page).toBeGreaterThan(0);
  const { page } = scrolled(c.target.reports);
  expect(scrolled(c.target.reports).inner).toBe(0);
  await aimable(c.page);
  await wheelAt(c.page, INNER, 300);
  await expect.poll(() => scrolled(c.target.reports).inner).toBeGreaterThan(0);
  await delay(500);
  expect(scrolled(c.target.reports).page).toBe(page);
  note("wheel-scroll", JSON.stringify(scrolled(c.target.reports)));
  await end(c);
});

test("negatives: an unknown key, an oversized text, and the typed marker leave nothing", async () => {
  const c = cell();
  await begin(c, "/interact/form");
  await focusField(c);
  const before = (await tabState(c.worker)).stats.dispatched;
  const f5 = await aimKey(c.page, "key", { code: "F5", phase: "down", modifiers: 0 });
  expect(f5).toMatchObject({ ok: false, code: "INPUT_UNSUPPORTED" });
  const long = await aimKey(c.page, "text", { text: "é".repeat(2_500) });
  expect(long).toMatchObject({ ok: false, code: "TEXT_TOO_LONG" });
  expect((await tabState(c.worker)).stats.dispatched).toBe(before);
  // The lease still holds: the next events are in sequence and the field is still empty.
  expect(await aimKey(c.page, "text", { text: MARKER })).toMatchObject({ ok: true });
  await c.page.keyboard.press("Enter");
  await expect.poll(() => submits(c).at(-1)?.value).toBe(MARKER);
  const worker = await workerText(c.worker, MARKER);
  const master = await masterText(c.page, MARKER);
  const states = JSON.stringify([
    await background(c.worker, "lab.interact.state()"),
    await call(c.page, "interactView"),
    await session(c.page),
  ]);
  await end(c);
  expect({ worker, master }).toEqual({
    worker: { keys: [], databaseHits: [], cacheHits: [] },
    master: { keys: [], databaseHits: [], cacheHits: [] },
  });
  expect(states).not.toContain(MARKER);
});

test("negatives control: the same scans find a planted marker on each side", async () => {
  const c = cell();
  const planted = JSON.stringify(Buffer.from(MARKER).toString("base64"));
  await background(c.worker, `chrome.storage.local.set({ probe: ${JSON.stringify(MARKER)} })`);
  await background(c.worker, `lab.plant(${planted})`);
  await call(c.page, "plant", JSON.parse(planted));
  try {
    expect((await workerText(c.worker, MARKER)).keys).toEqual(["probe"]);
    expect((await workerText(c.worker, MARKER)).databaseHits).toEqual(["recnrun-plant/frames"]);
    expect((await masterText(c.page, MARKER)).cacheHits).toHaveLength(1);
  } finally {
    await background(c.worker, `chrome.storage.local.remove("probe")`);
    await background(c.worker, "lab.unplant()");
    await call(c.page, "unplant");
  }
});

test("dead man: a button and a key held with nothing sent are let go within a second", async () => {
  const c = cell();
  await begin(c, "/interact/form");
  const before = (await releasedState(c.worker)).tabStats.released.DEADMAN ?? 0;
  // A master that hangs: its hold keepalive stops while the button and the key stay down.
  expect(await call(c.page, "interactKeepalive", false)).toBe(true);
  await holdBoth(c);
  const since = Date.now();
  const latency = await letGo(c, since);
  note("deadman-ms", String(latency));
  expect(latency).toBeLessThanOrEqual(1_500);
  const state = await releasedState(c.worker);
  expect(state.tabStats.released.DEADMAN).toBe(before + 1);
  expect(state.held).toBe(0);
  expect((await session(c.page)).lease?.ok).toBe(true);
  await c.page.mouse.up();
  await c.page.keyboard.up("ArrowDown");
  expect(await call(c.page, "interactKeepalive", true)).toBe(true);
  await end(c);
});

test("N5: the master closing mid-press lets go, releases the claim, and a new start works", async () => {
  const c = cell();
  await begin(c, "/interact/form");
  await holdBoth(c);
  const since = Date.now();
  await c.page.close();
  const latency = await letGo(c, since);
  note("master-close-ms", String(latency));
  expect(latency).toBeLessThanOrEqual(2_000);
  const state = await released(c.worker);
  expect((await releasedState(c.worker)).tab).toBeNull();
  note("master-close-released", JSON.stringify(state.stats.revoked));
  await restart(c);
});

test("N10: link loss mid-press gets the same cleanup, and a relinked start works", async () => {
  const c = cell();
  await begin(c, "/interact/form");
  await holdBoth(c);
  const since = Date.now();
  expect(await call(c.page, "interactDropLink", NAME)).toBe(true);
  const latency = await letGo(c, since);
  note("link-loss-ms", String(latency));
  expect(latency).toBeLessThanOrEqual(2_000);
  await released(c.worker);
  const state = await releasedState(c.worker);
  expect(state.tab).toBeNull();
  note("link-loss-released", JSON.stringify(state.tabStats.released));
  await restart(c);
});

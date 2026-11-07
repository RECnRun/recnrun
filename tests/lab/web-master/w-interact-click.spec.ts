import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import {
  aimable,
  aimedAt,
  clickAt,
  framesSent,
  letterbox,
  pointer,
  tabState,
} from "./interact-click-harness.ts";
import type { Point, SentFrame } from "./interact-click-harness.ts";
import { OTHER, interactStart, raw, released, session, stopInteract } from "./interact-harness.ts";
import { background, call, link, provisionWorker, startWorker } from "./lifecycle-harness.ts";
import { pageSigner } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, openLinked, provision } from "./trust-harness.ts";

/*
 * Slice B of docs/poc/thin-worker/W7-PLAN.md: the worker's own tab, frames that carry their
 * geometry, and pointer events aimed at a frame the worker sent, mapped to CSS pixels.
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
  if (!shared) throw new Error("The W7.B setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  const page = await openLinked(master, site.origin, worker);
  expect(await link(page, worker, OTHER)).toBe(true);
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

const CENTER = { x: 0.5, y: 0.5 };
const DOWN = { button: "left", clickCount: 1, modifiers: 0 };
const hitsOf = (c: Cell, id: string) => c.target.hits.filter((hit) => hit.id === id).length;

/** A lease on the fixture page, observed live, with the image letterboxed. */
async function begin(c: Cell): Promise<SentFrame> {
  const started = await interactStart(c.page, `${c.target.origin}/interact`);
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  expect(await call(c.page, "interactObserve", NAME)).toMatchObject({ ok: true });
  await letterbox(c.page);
  return aimable(c.page);
}

async function end(c: Cell) {
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
}

/** The corner boxes are 40 px squares: their centres sit 20 px in from each edge. */
const corners = (width: number, height: number): [string, Point][] => [
  ["tl", { x: 20, y: 20 }],
  ["tr", { x: width - 20, y: 20 }],
  ["bl", { x: 20, y: height - 20 }],
  ["br", { x: width - 20, y: height - 20 }],
];

test("I1: a click on the live frame raises the counter by one and hits each corner", async () => {
  const c = cell();
  const frame = await begin(c);
  const sentBefore = await framesSent(c.worker);
  await delay(2_000);
  const fps = ((await framesSent(c.worker)) - sentBefore) / 2;
  test.info().annotations.push({ type: "interact-fps", description: fps.toFixed(1) });
  expect(fps).toBeGreaterThan(10);
  expect(fps).toBeLessThanOrEqual(30);
  await clickAt(c.page, CENTER);
  await expect.poll(() => hitsOf(c, "count")).toBe(1);
  await delay(500);
  expect(hitsOf(c, "count")).toBe(1);
  const { deviceWidth, deviceHeight } = frame.geometry ?? { deviceWidth: 0, deviceHeight: 0 };
  const errors: number[] = [];
  for (const [id, css] of corners(deviceWidth, deviceHeight)) {
    await clickAt(c.page, { x: css.x / deviceWidth, y: css.y / deviceHeight });
    await expect.poll(() => c.target.hits.at(-1)?.id).toBe(id);
    const hit = c.target.hits.at(-1) ?? { x: 0, y: 0, w: 0, h: 0 };
    const expected = new Map(corners(hit.w, hit.h)).get(id) ?? { x: 0, y: 0 };
    errors.push(Math.hypot(hit.x - expected.x, hit.y - expected.y));
  }
  const worst = Math.max(...errors);
  test.info().annotations.push({ type: "calibration-css-px", description: worst.toFixed(2) });
  console.log(`W7.B fps ${fps.toFixed(1)}, worst corner error ${worst.toFixed(2)} CSS px`);
  expect(worst).toBeLessThanOrEqual(4);
  await end(c);
});

test("I1: stale, fabricated, wrong-lease, and other-link events have no effect", async () => {
  const c = cell();
  const old = await begin(c);
  const before = c.target.hits.length;
  const { dispatched } = (await tabState(c.worker)).stats;
  await delay(1_700);
  const stale = await pointer(c.page, "pointerDown", { ...aimedAt(old), ...DOWN });
  expect(stale).toMatchObject({ ok: false, code: "STALE_FRAME" });
  const fresh = await aimable(c.page);
  const aimed = { ...aimedAt(fresh), ...DOWN };
  const unknown = { ...aimed, frameSeq: fresh.frameSeq + 100_000 };
  expect(await pointer(c.page, "pointerDown", unknown)).toMatchObject({ code: "UNKNOWN_FRAME" });
  const otherBoot = { ...aimed, bootId: randomUUID() };
  expect(await pointer(c.page, "pointerDown", otherBoot)).toMatchObject({ code: "UNKNOWN_FRAME" });
  const { lease, seq } = await session(c.page);
  const event = { type: "INPUT_EVENT", kind: "pointerDown", ...aimed };
  const onOther = { ...event, leaseId: lease?.leaseId, seq: seq + 1 };
  expect(await raw(c.page, onOther, OTHER)).toMatchObject({ code: "LINK_MISMATCH" });
  const wrongLease = { ...event, leaseId: randomUUID(), seq: seq + 1 };
  expect(await raw(c.page, wrongLease)).toMatchObject({ ok: false });
  await delay(500);
  expect(c.target.hits.length).toBe(before);
  expect((await tabState(c.worker)).stats.dispatched).toBe(dispatched);
  await end(c);
});

test("N6: a click that leaves the allowlist revokes, closes the tab, and ends input", async () => {
  const c = cell();
  await begin(c);
  const tabId = (await tabState(c.worker)).tab?.tabId;
  // A tab the interact tab opens is closed by the worker at once.
  await clickAt(c.page, { x: 0.5, y: 0.8 });
  await expect.poll(async () => (await tabState(c.worker)).tabStats.openersClosed).toBe(1);
  const last = await aimable(c.page);
  await clickAt(c.page, { x: 0.85, y: 0.5 });
  await expect
    .poll(async () => (await session(c.page)).pushes.at(-1)?.reason)
    .toBe("TARGET_OFF_POLICY");
  expect((await released(c.worker)).stats.revoked.TARGET_OFF_POLICY).toBe(1);
  expect(await background(c.worker, `lab.interact.isOpen(${tabId})`)).toBe(false);
  expect((await tabState(c.worker)).tab).toBeNull();
  const after = await pointer(c.page, "pointerDown", { ...aimedAt(last), ...DOWN });
  expect(after).toMatchObject({ ok: false, code: "SESSION_REVOKED" });
});

test("N7: an event aimed before a navigation or a resize has no effect", async () => {
  const c = cell();
  const first = await begin(c);
  await clickAt(c.page, { x: 0.15, y: 0.5 });
  await aimable(c.page, (frame) => frame.loaderId !== first.loaderId);
  const before = hitsOf(c, "count");
  const navigated = await pointer(c.page, "pointerDown", { ...aimedAt(first), ...DOWN });
  expect(navigated).toMatchObject({ ok: false, code: "TARGET_CHANGED" });
  const second = await aimable(c.page);
  expect(await background(c.worker, "lab.interact.resize(800, 450)")).toBe(true);
  const width = second.geometry?.deviceWidth;
  await aimable(c.page, (frame) => frame.geometry?.deviceWidth !== width);
  const resized = await pointer(c.page, "pointerDown", { ...aimedAt(second), ...DOWN });
  expect(resized).toMatchObject({ ok: false, code: "VIEWPORT_CHANGED" });
  await delay(500);
  expect(hitsOf(c, "count")).toBe(before);
  expect(await background(c.worker, "lab.interact.resize(0, 0)")).toBe(true);
  await end(c);
});

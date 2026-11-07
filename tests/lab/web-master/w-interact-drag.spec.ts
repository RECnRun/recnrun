import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { aimable, letterbox, tabState } from "./interact-click-harness.ts";
import type { Point } from "./interact-click-harness.ts";
import {
  centreOf,
  dragOn,
  fraction,
  layoutOf,
  nth,
  rectOf,
  moveOn,
  pressOn,
  reports,
} from "./interact-drag-harness.ts";
import type { Layout } from "./interact-drag-harness.ts";
import { interactStart, released, stopInteract } from "./interact-harness.ts";
import { releasedState } from "./interact-input-harness.ts";
import { call, provisionWorker, startWorker } from "./lifecycle-harness.ts";
import { pageSigner } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, openLinked, provision } from "./trust-harness.ts";

/*
 * Slice D of docs/poc/thin-worker/W7-PLAN.md: a slider and a canvas dragged through the live
 * frame (I4), an HTML5 reorder with plain mouse events (I5, variant A), a press held still past
 * the dead man while the master is there, and link loss mid-drag.
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
  if (!shared) throw new Error("The W7.D setup did not run.");
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

const TARGET_VALUE = 70;
type Stroke = { points: Point[] };

/** A lease on a fixture page, observed live and letterboxed; answers the page's layout. */
async function begin(c: Cell, path: string): Promise<Layout> {
  const since = Date.now();
  const started = await interactStart(c.page, `${c.target.origin}${path}`);
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  expect(await call(c.page, "interactObserve", NAME)).toMatchObject({ ok: true });
  await letterbox(c.page);
  await aimable(c.page);
  return layoutOf(c.target, path, since);
}

async function end(c: Cell) {
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
}

/** The slider thumb's centre at `value`: the 20 px thumb travels the width less itself. */
const thumbAt = (layout: Layout, value: number) => {
  const r = rectOf(layout, "slider");
  return fraction(layout, r.left + 10 + (value / 100) * (r.width - 20), r.top + r.height / 2);
};

/** A point of the canvas, as fractions of its box. */
const onCanvas = (layout: Layout, fx: number, fy: number) => {
  const r = rectOf(layout, "canvas");
  return fraction(layout, r.left + fx * r.width, r.top + fy * r.height);
};
const inCanvas = (layout: Layout, point: Point) => ({
  x: point.x * layout.w - rectOf(layout, "canvas").left,
  y: point.y * layout.h - rectOf(layout, "canvas").top,
});
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const strokes = (c: Cell, since: number) =>
  reports(c.target, "stroke", since) as unknown as (Stroke & { at: number })[];

const note = (type: string, description: string) => {
  test.info().annotations.push({ type, description });
  console.log(`W7.D ${type} ${description}`);
};

test("I4: the slider's thumb dragged from min lands on the target value", async () => {
  const c = cell();
  const layout = await begin(c, "/interact/drag");
  const since = Date.now();
  await dragOn(c.page, thumbAt(layout, 0), thumbAt(layout, TARGET_VALUE));
  await expect.poll(() => reports(c.target, "change", since).length).toBe(1);
  const value = nth(reports(c.target, "change", since), 0).value as number;
  note("slider-value", `${value} for ${TARGET_VALUE}`);
  expect(Math.abs(value - TARGET_VALUE)).toBeLessThanOrEqual(1);
  expect(reports(c.target, "input", since).length).toBeGreaterThan(1);
  await end(c);
});

test("I4: a stroke drawn on the canvas follows the drag's path", async () => {
  const c = cell();
  const layout = await begin(c, "/interact/drag");
  const since = Date.now();
  const from = onCanvas(layout, 0.1, 0.2);
  const via = onCanvas(layout, 0.5, 0.8);
  const to = onCanvas(layout, 0.9, 0.3);
  await dragOn(c.page, from, to, [via]);
  await expect.poll(() => strokes(c, since).length).toBe(1);
  await delay(500);
  expect(strokes(c, since)).toHaveLength(1);
  const { points } = nth(strokes(c, since), 0);
  const [first, last] = [nth(points, 0), nth(points, -1)];
  const nearVia = Math.min(...points.map((p) => distance(p, inCanvas(layout, via))));
  note("stroke", `${points.length} points, via within ${nearVia.toFixed(1)} px`);
  expect(distance(first, inCanvas(layout, from))).toBeLessThanOrEqual(4);
  expect(distance(last, inCanvas(layout, to))).toBeLessThanOrEqual(4);
  expect(nearVia).toBeLessThanOrEqual(40);
  expect(points.length).toBeGreaterThanOrEqual(5);
  await end(c);
});

test("hold: a button held still past the dead man stays down while the master is there", async () => {
  const c = cell();
  const layout = await begin(c, "/interact/drag");
  const holdsBefore = (await tabState(c.worker)).stats as { holds?: number };
  const deadmanBefore = (await releasedState(c.worker)).tabStats.released.DEADMAN ?? 0;
  const since = Date.now();
  await pressOn(c.page, onCanvas(layout, 0.2, 0.5));
  await moveOn(c.page, onCanvas(layout, 0.4, 0.5));
  await delay(2_500);
  expect(reports(c.target, "pointerup", since)).toHaveLength(0);
  await moveOn(c.page, onCanvas(layout, 0.6, 0.5));
  await c.page.mouse.up();
  await expect.poll(() => strokes(c, since).length).toBe(1);
  await delay(500);
  expect(reports(c.target, "pointerup", since)).toHaveLength(1);
  const stats = (await tabState(c.worker)).stats as { holds?: number };
  const holds = (stats.holds ?? 0) - (holdsBefore.holds ?? 0);
  note("holds-in-2.5s", String(holds));
  expect(holds).toBeGreaterThanOrEqual(8);
  const deadman = (await releasedState(c.worker)).tabStats.released.DEADMAN ?? 0;
  expect(deadman - deadmanBefore).toBe(0);
  await end(c);
});

test("I5: an HTML5 drag with plain mouse events moves item 1 below item 3 once", async () => {
  const c = cell();
  const layout = await begin(c, "/interact/list");
  const since = Date.now();
  // The lower half of item 3: the fixture drops the source after it.
  await dragOn(c.page, centreOf(layout, "i1"), centreOf(layout, "i3", 20), [
    centreOf(layout, "i1", 30),
    centreOf(layout, "i2"),
  ]);
  const settled = () => reports(c.target, "dragend", since).length > 0;
  await expect.poll(settled, { timeout: 5_000 }).toBe(true);
  await delay(500);
  const drops = reports(c.target, "drop", since);
  const ends = reports(c.target, "dragend", since);
  note(
    "drag-events",
    JSON.stringify({ drops, ends, starts: reports(c.target, "dragstart", since) }),
  );
  expect(drops).toHaveLength(1);
  expect(nth(drops, 0)).toMatchObject({ data: "i1", order: ["i2", "i3", "i1", "i4"] });
  expect(ends).toHaveLength(1);
  expect(nth(ends, 0)).toMatchObject({ id: "i1" });
  await end(c);
});

test("I4: link loss mid-drag lets go, ends the stroke, and closes the tab", async () => {
  const c = cell();
  const layout = await begin(c, "/interact/drag");
  const since = Date.now();
  await pressOn(c.page, onCanvas(layout, 0.2, 0.3));
  await moveOn(c.page, onCanvas(layout, 0.5, 0.6));
  await expect.poll(() => reports(c.target, "strokestart", since).length).toBe(1);
  const lost = Date.now();
  expect(await call(c.page, "interactDropLink", NAME)).toBe(true);
  await expect.poll(() => reports(c.target, "pointerup", lost).length, { timeout: 2_500 }).toBe(1);
  await expect.poll(() => strokes(c, lost).length).toBe(1);
  const up = nth(reports(c.target, "pointerup", lost), 0).at - lost;
  note("link-loss-release-ms", String(up));
  expect(reports(c.target, "mouseup", lost)).toHaveLength(1);
  await released(c.worker);
  const state = await releasedState(c.worker);
  expect(state.tab).toBeNull();
  expect(state.held).toBe(0);
  await c.page.mouse.up();
});

import type { Page } from "@playwright/test";
import { screenAt } from "./interact-click-harness.ts";
import type { Point } from "./interact-click-harness.ts";
import { until } from "./lifecycle-harness.ts";
import type { Target } from "./target-server.ts";

/* Helpers of the W7 slice D cells: fixture layouts in frame fractions, and drags on the image. */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Layout {
  path: string;
  w: number;
  h: number;
  rects: Record<string, Rect>;
}

/** A fixture report with the fields its page added. */
export type Report = Record<string, unknown> & { type: string; at: number };

export const reports = (target: Target, type: string, after = 0) =>
  (target.reports as unknown as Report[]).filter((r) => r.type === type && r.at >= after);

/** The layout the fixture page at `path` last reported, after `after`. */
export const layoutOf = (target: Target, path: string, after = 0) =>
  until(
    async () => reports(target, "layout", after).findLast((r) => r.path === path),
    Boolean,
    10_000,
  ) as Promise<Report & Layout>;

/** A point of the page's CSS pixels as a fraction of its view, which is the frame's image. */
export const fraction = (layout: Layout, x: number, y: number): Point => ({
  x: x / layout.w,
  y: y / layout.h,
});

/** The box the page reported for element `id`. */
export const rectOf = (layout: Layout, id: string): Rect => {
  const r = layout.rects[id];
  if (!r) throw new Error(`The layout of ${layout.path} has no #${id}.`);
  return r;
};

/** The one item a check expects at `index`. */
export const nth = <T>(items: T[], index: number): T => {
  const item = items.at(index);
  if (item === undefined) throw new Error(`No item at ${index} of ${items.length}.`);
  return item;
};

/** The centre of an element of the layout, as a fraction of the view. */
export const centreOf = (layout: Layout, id: string, dy = 0): Point => {
  const r = rectOf(layout, id);
  return fraction(layout, r.left + r.width / 2, r.top + r.height / 2 + dy);
};

/** Presses the left button on the master's image where the frame's `point` is drawn. */
export async function pressOn(page: Page, point: Point): Promise<void> {
  const { x, y } = await screenAt(page, point);
  await page.mouse.move(x, y);
  await page.mouse.down();
}

/** Moves the master's pointer to the frame's `point` in `steps` moves, as a hand would. */
export async function moveOn(page: Page, point: Point, steps = 10): Promise<void> {
  const { x, y } = await screenAt(page, point);
  await page.mouse.move(x, y, { steps });
}

/** Presses at `from`, drags through `via` to `to`, and lets go there. */
export async function dragOn(page: Page, from: Point, to: Point, via: Point[] = []) {
  await pressOn(page, from);
  for (const point of [...via, to]) await moveOn(page, point);
  await page.mouse.up();
}

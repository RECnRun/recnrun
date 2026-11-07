import type { Page } from "@playwright/test";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import type { InputReport } from "./input-fixtures.ts";
import type { InputReply } from "./interact-harness.ts";
import { screenAt } from "./interact-click-harness.ts";
import type { Point } from "./interact-click-harness.ts";
import { background, call } from "./lifecycle-harness.ts";
import { NAME } from "./trust-harness.ts";

/* Helpers of the W7 slice C cells: wheels and presses on the master's image, and readouts. */

export interface Released {
  held: number;
  tab: { tabId: number } | null;
  tabStats: { released: Record<string, number>; releaseEvents: number; releaseFailed: number };
}

export interface TextHits {
  keys: string[];
  databaseHits: string[];
  cacheHits: string[];
}

/** One wheel over the master's image where the frame's `point` is drawn. */
export async function wheelAt(page: Page, point: Point, deltaY: number): Promise<void> {
  const { x, y } = await screenAt(page, point);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, deltaY);
}

/** Presses the left button over the master's image and leaves it held. */
export async function pressAt(page: Page, point: Point): Promise<void> {
  const { x, y } = await screenAt(page, point);
  await page.mouse.move(x, y);
  await page.mouse.down();
}

/** A key or text event aimed at the frame the master shows now, with no point. */
export const aimKey = (page: Page, kind: "key" | "text", fields: object) =>
  call<InputReply | null>(page, "interactAim", NAME, kind, {}, fields);

export const releasedState = (worker: LoadedExtension) =>
  background<Released>(worker, "lab.interact.state()");
export const workerText = (worker: LoadedExtension, marker: string) =>
  background<TextHits>(worker, `lab.scanText(${JSON.stringify(marker)})`);
export const masterText = (page: Page, marker: string) => call<TextHits>(page, "scanText", marker);

export const reportsOf = (reports: InputReport[], type: string, after = 0) =>
  reports.filter((report) => report.type === type && report.at >= after);

/** The page's last scroll positions, or zeros before any scroll. */
export const scrolled = (reports: InputReport[]) => {
  const last = reportsOf(reports, "scroll").at(-1);
  return { page: last?.page ?? 0, inner: last?.inner ?? 0 };
};

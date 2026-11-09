import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect } from "../../browser/fixtures/chrome.ts";
import { aimable, letterbox } from "./interact-click-harness.ts";
import type { Point, SentFrame } from "./interact-click-harness.ts";
import { centreOf, layoutOf, reports } from "./interact-drag-harness.ts";
import { interactStart } from "./interact-harness.ts";
import { call, until } from "./lifecycle-harness.ts";
import type { Target } from "./target-server.ts";
import { NAME } from "./trust-harness.ts";

/* W7 slice D: presses on the latency page, timed to their reply and their presented frame. */

export interface LatencyCell {
  target: Target;
  page: Page;
}

interface Click {
  ok: boolean;
  ackMs: number;
  visibleMs: number | null;
}

export interface Strip {
  block: Point;
  cells: Point[];
}

export const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Number((sorted[Math.floor(q * (sorted.length - 1))] ?? 0).toFixed(1));
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};
export const rounded = (values: number[]) => values.map((value) => Number(value.toFixed(1)));

const BITS = 8;

/** A lease on the latency page, observed live; answers the block's and the id cells' centres. */
export async function begin(c: LatencyCell): Promise<Strip> {
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
export const click = (c: LatencyCell, strip: Strip, id: number | null) =>
  call<Click>(
    c.page,
    "latencyClick",
    NAME,
    strip.block,
    id === null ? null : { id, cells: strip.cells },
  );
export const presses = (c: LatencyCell, since: number) =>
  reports(c.target, "press", since).map((report) => report.n as number);

/** `count` presses, each timed to its reply and to the presented frame that draws its count. */
export async function sampleClicks(c: LatencyCell, strip: Strip, count: number) {
  const since = Date.now();
  const ack: number[] = [];
  const visible: number[] = [];
  for (let n = 1; n <= count; n += 1) {
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
  expect(presses(c, since)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  return { ack, visible };
}

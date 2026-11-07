import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { submitDirect } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import { background, call, until } from "./lifecycle-harness.ts";
import type { JobOp } from "./lifecycle-harness.ts";
import { fields } from "./trust-harness.ts";

/* Helpers of the W6 visual cells: lab.visual readouts on the worker's service worker only. */

export type Rgb = [number, number, number];

interface FrameEntry {
  type: "frame" | "NO_CHANGE";
  frameSeq?: number;
  epoch: number;
  source?: "screencast" | "screenshot";
  bytes?: number;
  capturedAtMs?: number;
  at: number;
}

export interface VisualStats {
  state: string;
  mode: string | null;
  epoch: number;
  produced: number;
  screenshots: number;
  acked: number;
  heartbeats: number;
  bytes: number;
  decodeMs: number;
  starts: number;
  drops: Record<string, number>;
  visibility: { visible: boolean; at: number }[];
  detached: { reason: string; at: number } | null;
  errors: string[];
  log: FrameEntry[];
  epochs: { epoch: number; url: string; at: number }[];
}

export const BLUE: Rgb = [0x20, 0x50, 0xc0];
export const ORANGE: Rgb = [0xe0, 0xa0, 0x20];
export const GREEN: Rgb = [0x20, 0xa0, 0x40];
export const GRAY: Rgb = [0x80, 0x80, 0x80];
// A point of the fixture's canvas colour, clear of the button, spinner, and modal.
const PANEL = [0.5, 0.8] as const;

const literal = (args: unknown[]) => args.map((value) => JSON.stringify(value)).join(",");

export const visual = <T>(worker: LoadedExtension, method: string, ...args: unknown[]) =>
  background<T>(worker, `lab.visual.${method}(${literal(args)})`);

export const visualStats = (worker: LoadedExtension) => visual<VisualStats>(worker, "stats");

const pixel = (worker: LoadedExtension) => visual<Rgb | null>(worker, "pixel", ...PANEL);

const near = (rgb: Rgb | null, want: Rgb, tolerance = 48) =>
  rgb !== null && rgb.every((value, index) => Math.abs(value - (want[index] ?? 0)) <= tolerance);

/** Waits until the latest frame's panel shows `want`. */
export async function panelShows(worker: LoadedExtension, want: Rgb, ms = 15_000) {
  try {
    return await until(
      () => pixel(worker),
      (rgb) => near(rgb, want),
      ms,
    );
  } catch (error) {
    // The capture's own account says why no frame showed the panel.
    const { log, ...stats } = await visualStats(worker);
    await saveFrame(worker, `no-panel-${Date.now()}.jpg`);
    throw new Error(`${String(error)}; ${JSON.stringify({ ...stats, log: log.slice(-5) })}`);
  }
}

export const frames = (stats: VisualStats) => stats.log.filter((entry) => entry.type === "frame");

/** Frames per second and mean JPEG bytes the screencast produced over `ms`. */
export async function rate(worker: LoadedExtension, ms = 2_000) {
  const before = await visualStats(worker);
  const started = performance.now();
  await delay(ms);
  const after = await visualStats(worker);
  const seconds = (performance.now() - started) / 1_000;
  const produced = after.produced - before.produced;
  const bytes = after.bytes - before.bytes;
  const decodeMs = after.decodeMs - before.decodeMs;
  return {
    fps: Number((produced / seconds).toFixed(2)),
    meanBytes: produced ? Math.round(bytes / produced) : 0,
    decodeMsPerFrame: produced ? Number((decodeMs / produced).toFixed(3)) : 0,
  };
}

export const op = (name: string, args: Record<string, unknown>, timeoutMs = 10_000): JobOp => ({
  op: name,
  args,
  timeoutMs,
});

/** Ops 0–7: the fixture, its click, the second document, the static page. */
export const visualOps = (origin: string): JobOp[] => [
  op("navigate", { url: `${origin}/visual` }),
  op("wait", { selector: "#go", state: "attached" }),
  op("click", { selector: "#go" }),
  op("wait", { selector: "#after", state: "attached" }),
  op("navigate", { url: `${origin}/visual/second` }),
  op("wait", { selector: "#second", state: "attached" }),
  op("navigate", { url: `${origin}/visual/static` }),
  op("wait", { selector: "#static", state: "attached" }),
];

/** Holds the runner at `index`/`phase`, then waits until it is there. */
export async function holdAt(worker: LoadedExtension, index: number, phase = "between") {
  await background(worker, `lab.setKnob(${JSON.stringify({ index, phase })})`);
}

export async function reached(worker: LoadedExtension, index: number, phase = "between") {
  const read = () =>
    background<{ reached: { index: number; phase: string } | null }>(worker, "lab.state()");
  await until(
    read,
    (state) => state.reached?.index === index && state.reached.phase === phase,
    30_000,
  );
}

/** Submits the visual job held at `holdIndex` and waits until the runner is there; answers its id. */
export async function startVisualJob(
  worker: LoadedExtension,
  key: Signer,
  origin: string,
  holdIndex: number,
) {
  await holdAt(worker, holdIndex);
  const job = await key.sign(fields(origin, { ops: visualOps(origin) }));
  expect((await submitDirect(worker, job)).status).toBe("ACCEPTED");
  await reached(worker, holdIndex);
  return String(job.jobId);
}

/** Moves the runner's hold from where it is to `next`, then waits until it gets there. */
export async function advance(worker: LoadedExtension, next: number, phase = "between") {
  await holdAt(worker, next, phase);
  expect(await background<boolean>(worker, "lab.release()")).toBe(true);
  await reached(worker, next, phase);
}

/** Waits until the master page's own image of the worker shows `want` at the panel point. */
export async function masterShows(page: Page, want: Rgb, ms = 15_000) {
  return until(
    () => call<Rgb | null>(page, "visualPixel", ...PANEL),
    (rgb) => near(rgb, want),
    ms,
  );
}

/** Writes the latest frame under the run's evidence directory. */
export async function saveFrame(worker: LoadedExtension, name: string) {
  const data = await visual<string | null>(worker, "latest");
  if (data === null) return;
  const directory = join(".artifacts/evidence", process.env.RECNRUN_RUN_ID ?? "local");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), Buffer.from(data, "base64"));
}

export async function writeEvidence(name: string, evidence: unknown) {
  const directory = join(".artifacts/evidence", process.env.RECNRUN_RUN_ID ?? "local");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
}

import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { submitDirect } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import { background, call, jobOps, until } from "./lifecycle-harness.ts";
import type { JobOp } from "./lifecycle-harness.ts";
import { NAME, fields } from "./trust-harness.ts";
import { holdAt, op, reached, visualOps } from "./visual-harness.ts";

/* Helpers of the W6 slice C cells: signed observe requests from the master page, and readouts. */

// The worker's request rate window: a case that counts refusals starts on an empty window.
export const RATE_WINDOW_MS = 10_500;

export interface ObserveReply {
  ok: boolean;
  code?: string;
  requestId: string | null;
}

export interface ObserveStats {
  accepted: number;
  refused: Record<string, number>;
  errors: { code: string; at: number }[];
  ended: { reason: string; sessionEpoch: number; at: number }[];
  policyDrops: number;
  sent: number;
  gate: { sent: number; bytes: number; drops: Record<string, number>; pending: boolean };
  session: {
    startedAt: number;
    authorizedUntil: number;
    firstFrameAt: number;
    mode: string;
  } | null;
}

export interface MasterStats {
  frames: number;
  drops: Record<string, number>;
  sessions: { firstFrameMs: number | null }[];
  size: [number, number];
}

interface MasterEvents {
  heartbeats: { state: string; reason?: string }[];
  errors: { code: string }[];
  renewals: { ok: number; refused: Record<string, number> };
}

/** The page's own master key, made by the owner's pairing, as a signer for the worker's jobs. */
export async function pageSigner(page: Page): Promise<Signer> {
  return {
    publicKey: await call<JsonWebKey>(page, "pair"),
    sign: (values) => call<Record<string, unknown>>(page, "signFields", values),
  };
}

export const observeStats = (worker: LoadedExtension) =>
  background<ObserveStats>(worker, "lab.observe.stats()");
export const masterStats = (page: Page) => call<MasterStats>(page, "visualStats");
export const masterEvents = (page: Page, name = NAME) =>
  call<MasterEvents>(page, "observeEvents", name);

export const observeStart = (
  page: Page,
  jobId: string,
  mode: "thumbnail" | "live",
  link: { name?: string; workerId?: string } = {},
) => call<ObserveReply>(page, "observeStart", link.name ?? NAME, jobId, mode, link.workerId);

/** A request of the current session with `overrides`, signed by `key` (the page's when absent). */
export async function sendSigned(
  page: Page,
  type: string,
  overrides: Record<string, unknown>,
  key?: Signer,
) {
  const signed = await call<Record<string, unknown>>(page, "observeSigned", NAME, type, overrides);
  const { signature: _page, ...unsigned } = signed;
  const request = key ? await key.sign(unsigned) : signed;
  return call<ObserveReply>(page, "observeSendRaw", NAME, request);
}

/** The fixture's first document, then the form whose POST is the job's mutation. */
export const postOps = (origin: string, jobId: string): JobOp[] => [
  ...visualOps(origin).slice(0, 2),
  ...jobOps(origin, jobId),
];

/** The fixture, then a redirect to a host the job never allowed. */
export const awayOps = (origin: string): JobOp[] => [
  ...visualOps(origin).slice(0, 2),
  op("navigate", { url: `${origin}/visual/away` }),
  op("wait", { selector: "#static", state: "attached" }),
];

/** Submits a job held before op 2, whose ops `opsOf` builds from its id; answers the id. */
export async function startHeld(
  worker: LoadedExtension,
  key: Signer,
  origin: string,
  opsOf: (jobId: string) => JobOp[],
) {
  const hold = 2;
  await holdAt(worker, hold);
  const base = fields(origin);
  const job = await key.sign({ ...base, ops: opsOf(base.jobId) });
  expect((await submitDirect(worker, job)).status).toBe("ACCEPTED");
  await reached(worker, hold);
  return base.jobId;
}

export async function letRun(worker: LoadedExtension) {
  await background(worker, "lab.setKnob(null)");
  await background(worker, "lab.release()");
}

/** A link whose page never checks the worker's proof. */
export async function unprovenLink(page: Page, worker: LoadedExtension, name: string) {
  const offer = await call<string>(page, "offer", name);
  const answer = await background<string>(worker, `lab.answer(${JSON.stringify(offer)})`);
  await call<number>(page, "accept", name, answer);
}

/** Frames the master showed and the worker sent over `ms`. */
export async function flow(page: Page, worker: LoadedExtension, ms: number) {
  const [shown, sent] = [await masterStats(page), await observeStats(worker)];
  await delay(ms);
  const [shown2, sent2] = [await masterStats(page), await observeStats(worker)];
  return {
    shown: shown2.frames - shown.frames,
    sent: sent2.gate.sent - sent.gate.sent,
    bytesPerSecond: Math.round(((sent2.gate.bytes - sent.gate.bytes) * 1_000) / ms),
    size: shown2.size,
  };
}

/** Waits for the first frame of the session the master began last; the image may be stale. */
export const firstFrame = (page: Page) =>
  until(
    () => masterStats(page),
    (stats) => stats.sessions.some((session) => session.firstFrameMs !== null),
    15_000,
  );

// W6 slice A: the worker captures its job tab over the runner's own debuggee, never another client.
import { decodeFrame, fit } from "./frame-bytes.js";

export const MODES = {
  thumbnail: { maxWidth: 480, maxHeight: 270 },
  live: { maxWidth: 960, maxHeight: 540 },
};
const QUALITY = 50;
const HEARTBEAT_MS = 1_000;
const FIRST_FRAME_MS = 1_000;
const SCREENSHOT_MS = 3_000;
const LOG_MAX = 400;
// Frames of one service-worker life share a boot; the master starts over on a new one.
const BOOT_ID = crypto.randomUUID();

const fresh = () => ({
  state: "IDLE",
  mode: null,
  epoch: 0,
  produced: 0,
  screenshots: 0,
  acked: 0,
  heartbeats: 0,
  bytes: 0,
  decodeMs: 0,
  starts: 0,
  drops: { epoch: 0, replaced: 0, stopped: 0, generation: 0 },
  visibility: [],
  detached: null,
  errors: [],
  log: [],
  epochs: [],
});

const stats = fresh();
/**
 * @type {{ wanted: any, target: { tabId: number } | null, epochStartedAt: number,
 *   lastFrameAt: number, last: any, slot: any, sink: ((frame: any) => Promise<unknown>) | null,
 *   inflight: boolean, seq: number, timers: number[], jobId: string | null, generation: number }}
 */
const session = {
  wanted: null,
  target: null,
  epochStartedAt: 0,
  lastFrameAt: 0,
  last: null,
  slot: null,
  sink: null,
  inflight: false,
  seq: 0,
  timers: [],
  jobId: null,
  url: "",
  // Bumped whenever the document, the target, or the capture changes; older work is dropped.
  generation: 0,
};
// Slice C's observe session listens here; the capture itself decides nothing about policy.
/** @type {{ navigated?: (url: string) => void, detached?: () => void, unbound?: () => void }} */
let hooks = {};

const command = (method, params = {}) =>
  chrome.debugger.sendCommand(session.target, method, params);

const note = (entry) => {
  stats.log.push(entry);
  if (stats.log.length > LOG_MAX) stats.log.shift();
};

const fail = (error) => {
  stats.errors.push(String(error?.message ?? error));
};

// One frame in flight to the sink; a newer frame replaces the pending one.
const pump = async () => {
  if (session.inflight || !session.slot || !session.sink) return;
  const frame = session.slot;
  session.slot = null;
  session.inflight = true;
  await session.sink(frame).catch(fail);
  session.inflight = false;
  void pump();
};

const renew = () => {
  session.generation += 1;
};

const keep = (data, source, capturedAtMs) => {
  const { bytes, width, height, decodeMs } = decodeFrame(data);
  session.seq += 1;
  const frame = { data, bytes, width, height, source, capturedAtMs, frameSeq: session.seq };
  frame.epoch = stats.epoch;
  frame.generation = session.generation;
  frame.url = session.url;
  Object.assign(frame, { bootId: BOOT_ID, jobId: session.jobId, tabId: session.target.tabId });
  stats.bytes += bytes.length;
  stats.decodeMs += decodeMs;
  session.last = frame;
  session.lastFrameAt = Date.now();
  note({
    type: "frame",
    frameSeq: frame.frameSeq,
    epoch: frame.epoch,
    source,
    capturedAtMs,
    width,
    height,
  });
  stats.log.at(-1).bytes = bytes.length;
  stats.log.at(-1).at = session.lastFrameAt;
  if (!session.sink) return;
  if (session.slot) stats.drops.replaced += 1;
  session.slot = frame;
  void pump();
};

// The renderer stamps frames in seconds of wall time; a missing stamp counts as now.
const stampOf = (metadata) => (metadata?.timestamp ? metadata.timestamp * 1_000 : Date.now());

const onFrame = ({ data, metadata, sessionId }) => {
  // Ack before anything else: the screencast never waits on this worker's work or the network.
  stats.acked += 1;
  void command("Page.screencastFrameAck", { sessionId }).catch(fail);
  stats.produced += 1;
  if (stats.state !== "ACTIVE" && stats.state !== "STARTING") {
    stats.drops.stopped += 1;
    return;
  }
  const capturedAtMs = stampOf(metadata);
  // A frame drawn before the main frame committed belongs to the previous document.
  if (capturedAtMs < session.epochStartedAt) {
    stats.drops.epoch += 1;
    return;
  }
  keep(data, "screencast", capturedAtMs);
};

// No clip and no scale: either would resize the page's view while Chrome takes the shot.
const screenshot = async () => {
  const { generation, target } = session;
  const shot = command("Page.captureScreenshot", { format: "jpeg", quality: QUALITY });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("SCREENSHOT_TIMEOUT")), SCREENSHOT_MS),
  );
  const { data } = await Promise.race([shot, timeout]);
  const capturedAtMs = Date.now();
  const fitted = await fit(data, MODES[stats.mode], QUALITY);
  // A reply that crossed a navigation, a rebind, or a restart shows a document it cannot name.
  if (generation !== session.generation || target !== session.target) {
    stats.drops.generation += 1;
    return;
  }
  stats.screenshots += 1;
  keep(fitted, "screenshot", capturedAtMs);
};

// A page that draws nothing new gets one screenshot, so the viewer is never left blank.
const fallback = (epoch) => {
  const timer = setTimeout(() => {
    const drawn = session.last && session.last.epoch === epoch;
    if (stats.state === "ACTIVE" && epoch === stats.epoch && !drawn) screenshot().catch(fail);
  }, FIRST_FRAME_MS);
  session.timers.push(timer);
};

const onNavigated = (frame) => {
  if (frame.parentId) return;
  renew();
  stats.epoch += 1;
  session.epochStartedAt = Date.now();
  session.url = frame.url;
  hooks.navigated?.(frame.url);
  stats.epochs.push({ epoch: stats.epoch, url: frame.url, at: session.epochStartedAt });
  if (session.slot) stats.drops.epoch += 1;
  session.slot = null;
  if (stats.state === "ACTIVE") fallback(stats.epoch);
};

const heartbeat = () => {
  if (stats.state !== "ACTIVE" || Date.now() - session.lastFrameAt < HEARTBEAT_MS) return;
  stats.heartbeats += 1;
  note({ type: "NO_CHANGE", epoch: stats.epoch, at: Date.now() });
};

const clearTimers = () => {
  for (const timer of session.timers) clearTimeout(timer);
  session.timers = [];
};

const HANDLERS = {
  "Page.screencastFrame": onFrame,
  "Page.frameNavigated": ({ frame }) => onNavigated(frame),
  "Page.screencastVisibilityChanged": ({ visible }) =>
    stats.visibility.push({ visible, at: Date.now() }),
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!session.target || source.tabId !== session.target.tabId) return;
  HANDLERS[method]?.(params);
});

// Reported once; the worker never re-attaches on its own.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!session.target || source.tabId !== session.target.tabId) return;
  clearTimers();
  renew();
  stats.state = "DETACHED";
  stats.detached = { reason, at: Date.now() };
  session.target = null;
  session.slot = null;
  hooks.detached?.();
});

const begin = async () => {
  const { mode, everyNthFrame = 1, quality = QUALITY } = session.wanted;
  stats.state = "STARTING";
  stats.mode = mode;
  stats.starts += 1;
  session.lastFrameAt = Date.now();
  const params = { format: "jpeg", quality, everyNthFrame, ...MODES[mode] };
  await command("Page.startScreencast", params);
  stats.state = "ACTIVE";
  session.timers.push(setInterval(heartbeat, HEARTBEAT_MS));
  // After the screencast starts: a hidden tab with no capturer draws nothing to screenshot.
  await screenshot().catch(fail);
};

const halt = async () => {
  clearTimers();
  renew();
  if (stats.state !== "ACTIVE" && stats.state !== "STARTING") return;
  stats.state = "IDLE";
  await command("Page.stopScreencast").catch(fail);
};

const run = (work) =>
  work.catch((error) => {
    fail(error);
    stats.state = "ERROR";
  });

/** The runner hands its debuggee over once the job tab is set up. */
export const bind = (target, jobId) => {
  renew();
  session.target = target;
  session.jobId = jobId;
  session.epochStartedAt = 0;
  session.url = "";
  stats.detached = null;
  if (session.wanted) void run(begin());
};

/** The runner takes it back before it detaches; no command waits on the capture. */
export const unbind = (target) => {
  if (session.target?.tabId !== target.tabId) return;
  clearTimers();
  renew();
  void command("Page.stopScreencast").catch(() => false);
  stats.state = "ENDED";
  session.target = null;
  session.slot = null;
  hooks.unbound?.();
};

export const start = async (options) => {
  if (!MODES[options?.mode]) return { ok: false, error: "UNKNOWN_MODE" };
  await halt();
  session.wanted = options;
  if (session.target) await run(begin());
  return { ok: true };
};

export const stop = async () => {
  session.wanted = null;
  await halt();
  return { ok: true };
};

/** Slice B's transport: an async consumer of one frame at a time, or null. */
export const setSink = (sink) => {
  session.sink = sink;
  session.slot = null;
};

export const setHooks = (value) => {
  hooks = value;
};

export const captureStats = () => stats;
export const bootId = () => BOOT_ID;
/** @returns {any} */
export const lastFrame = () => session.last;
/** @returns {{ tabId: number } | null} */
export const boundTarget = () => session.target;
/** A frame of the document, target, and capture that are live now. */
export const isCurrent = (frame) =>
  frame.generation === session.generation && frame.tabId === session.target?.tabId;

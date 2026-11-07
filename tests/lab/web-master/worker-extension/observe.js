// W6 slice C: one observe session per worker, bound to the running job's tab and a lease.
import { bootId, captureStats, isCurrent, setHooks, setSink, start, stop } from "./capture.js";
import { load } from "./ledger.js";
import { createObserveCheck } from "./observe-check.js";
import { createGate } from "./observe-gate.js";
import { current } from "./runner.js";

const TICK_MS = 250;
const HEARTBEAT_MS = 1_000;
// The master renews about every second; three missed renewals end the session.
const limits = { leaseMs: 3_000, maxAuthMs: 600_000 };

/** @type {any} */
let session = null;
let highestEpoch = 0;
const stats = { accepted: 0, refused: {}, errors: [], ended: [], policyDrops: 0, sent: 0 };
const checker = createObserveCheck();

const toOffscreen = (message) =>
  chrome.runtime.sendMessage({ target: "offscreen", ...message }).catch(() => false);
const push = (message) => toOffscreen({ type: "push", linkId: session?.linkId, message });

/** Only http(s) documents of the job's own origins are ever shown. */
const allowed = (url, origins) => {
  if (!/^https?:\/\//.test(url)) return false;
  return origins.includes(new URL(url).origin);
};

const expiry = () => {
  const now = Date.now();
  if (now > session.leaseUntil) return "LEASE_EXPIRED";
  return now > session.authorizedUntil ? "AUTHORIZATION_EXPIRED" : null;
};

/** Checked at every handoff: an unexpired session, its running job, its tab, its live document. */
const live = (frame) => {
  if (!session) return false;
  const expired = expiry();
  if (expired) {
    end(expired);
    return false;
  }
  const job = current();
  if (!job || job.jobId !== session.jobId || frame.jobId !== session.jobId) return false;
  if (frame.tabId !== session.targetId || !isCurrent(frame)) return false;
  return allowed(frame.url, session.origins);
};

// Frames leave over chrome.runtime as base64; the offscreen document owns visual.v1.
const gate = createGate({
  valid: live,
  send: (frame) => {
    const { bootId: boot, jobId, tabId, epoch, frameSeq, width, height, capturedAtMs } = frame;
    const meta = { bootId: boot, jobId, targetId: tabId, epoch, frameSeq, width, height };
    stats.sent += 1;
    if (!session.firstFrameAt) session.firstFrameAt = Date.now();
    const validUntil = Math.min(session.leaseUntil, session.authorizedUntil);
    void toOffscreen({
      type: "visual-frame",
      frame: { ...meta, capturedAtMs, data: frame.data, queuedAt: Date.now(), validUntil },
    });
  },
});

const sink = async (frame) => {
  if (!live(frame)) {
    stats.policyDrops += 1;
    return;
  }
  gate.offer(frame);
};

const heartbeat = () => {
  const capture = captureStats();
  const { sent, drops } = gate.stats();
  return {
    type: "VISUAL_HEARTBEAT",
    bootId: bootId(),
    jobId: session?.jobId ?? null,
    sessionEpoch: session?.sessionEpoch ?? null,
    mode: session?.mode ?? "off",
    state: session ? capture.state : "OFF",
    sent,
    drops,
    authorizedUntil: session?.authorizedUntil ?? null,
    at: Date.now(),
  };
};

/** Stops the capture and frees the frame held for sending; the job and ledger are untouched. */
const end = (reason) => {
  if (!session) return;
  const ended = session;
  void push({ ...heartbeat(), state: "ENDED", reason });
  session = null;
  gate.setMode(null);
  setSink(null);
  void stop();
  void toOffscreen({ type: "visual-clear" });
  stats.ended.push({ reason, sessionEpoch: ended.sessionEpoch, at: Date.now() });
};

const fail = (code) => {
  if (!session) return;
  const error = { type: "VISUAL_ERROR", code, jobId: session.jobId, at: Date.now() };
  stats.errors.push(error);
  void push({ ...error, sessionEpoch: session.sessionEpoch });
  end(code);
};

setHooks({
  // A document off policy ends the session before any of its frames reaches the gate.
  navigated: (url) => {
    // The held frame shows the previous document.
    gate.clear();
    if (session && url !== "about:blank" && !allowed(url, session.origins)) {
      fail("TARGET_OFF_POLICY");
    }
  },
  detached: () => fail("CDP_DETACHED"),
  unbound: () => end("JOB_ENDED"),
});

setInterval(() => {
  const expired = session && expiry();
  if (expired) end(expired);
}, TICK_MS);
setInterval(() => session && void push(heartbeat()), HEARTBEAT_MS);

const begin = async (request, job, linkId) => {
  const now = Date.now();
  end("REPLACED");
  highestEpoch = Math.max(highestEpoch, request.sessionEpoch);
  session = {
    sessionEpoch: request.sessionEpoch,
    jobId: job.jobId,
    targetId: job.tabId,
    origins: job.origins,
    mode: request.mode,
    linkId,
    leaseUntil: now + limits.leaseMs,
    authorizedUntil: now + limits.maxAuthMs,
    startedAt: now,
    firstFrameAt: 0,
  };
  gate.setMode(request.mode);
  setSink(sink);
  await toOffscreen({ type: "visual-select", linkId });
  return start({ mode: request.mode });
};

const ACTIONS = {
  OBSERVE_START: begin,
  OBSERVE_SET_MODE: async (request) => {
    session.mode = request.mode;
    gate.setMode(request.mode);
    return start({ mode: request.mode });
  },
  OBSERVE_STOP: async () => end("STOPPED"),
  OBSERVE_STATUS: async () => undefined,
};

const contextOf = async () => {
  const job = current();
  const { provision } = await chrome.storage.local.get("provision");
  return {
    masterKey: provision?.masterKey,
    workerId: chrome.runtime.id,
    bootId: bootId(),
    job: job && { jobId: job.jobId, targetId: job.tabId },
    // Any ledger entry of a job that is not running is a finished (or interrupted) job.
    finished: async (jobId) => Boolean(await load(jobId)),
    session,
    highestEpoch,
  };
};

// What the checks saw before their awaits may have changed: rechecked just before acting.
const liveError = (request) => {
  const job = current();
  if (Date.now() > request.expiresAt) return "EXPIRED";
  if (!job || job.jobId !== request.jobId) return "JOB_FINISHED";
  if (job.tabId !== request.targetId) return "WRONG_TARGET";
  if (request.type === "OBSERVE_START") {
    return request.sessionEpoch > highestEpoch ? null : "OLD_EPOCH";
  }
  return session?.sessionEpoch === request.sessionEpoch ? null : "NO_SESSION";
};

const handle = async (request, linkId) => {
  const context = await contextOf();
  const checked = context.masterKey ? await checker.check(request, context) : "UNPROVISIONED";
  const refused = checked ?? liveError(request);
  const requestId = request?.requestId ?? null;
  if (refused) {
    stats.refused[refused] = (stats.refused[refused] ?? 0) + 1;
    return { ok: false, code: refused, requestId };
  }
  stats.accepted += 1;
  await ACTIONS[request.type](request, current(), linkId);
  if (session) session.leaseUntil = Date.now() + limits.leaseMs;
  return { ok: true, requestId, status: heartbeat() };
};

let queue = Promise.resolve();
/** A relayed request from link `linkId`: one at a time, refused and counted or acted on. */
export const observe = (request, linkId) => {
  const reply = queue.then(() => handle(request, linkId));
  queue = reply.catch(() => undefined);
  return reply;
};

export const observeLab = {
  stats: () => ({ ...stats, gate: gate.stats(), session, highestEpoch }),
  // Lab only: a shorter bound for a test; a request from the site can never reach this.
  limit: (overrides) => {
    for (const [key, value] of Object.entries(overrides)) {
      limits[key] = Math.min(limits[key], value);
    }
    return { ...limits };
  },
};

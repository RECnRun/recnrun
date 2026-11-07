// W6 slice C: the master's signed observe requests, its lease renewals, and the worker's telemetry.
import { sign } from "./jobs.js";
import { createReplies } from "./observe-replies.js";

const TTL_MS = 10_000;
const RENEW_MS = 1_000;
const KEEP = 50;
// Waits before each fresh start after a lapse; past the last one the master stops asking.
const RESTART_MS = [1_000, 2_000, 4_000];
// The owner's grant: restarts never stretch one Observe past it.
const GRANT_MS = 600_000;
// Ends and refusals no fresh start may undo: the owner, the job, the policy, or the trust said no.
export const FINAL = new Set([
  "STOPPED",
  "REPLACED",
  "JOB_ENDED",
  "JOB_FINISHED",
  "UNKNOWN_JOB",
  "WRONG_TARGET",
  "WRONG_WORKER",
  "UNPINNED_MASTER",
  "UNPROVISIONED",
  "AUTHORIZATION_EXPIRED",
  "TARGET_OFF_POLICY",
  "CDP_DETACHED",
  "CLOSED",
]);

const nonce = () => crypto.randomUUID().replaceAll("-", "");

const requestOf = (session, type, issuedAt, overrides) => ({
  type,
  requestId: crypto.randomUUID(),
  workerId: session.workerId,
  bootId: session.bootId,
  jobId: session.jobId,
  targetId: session.targetId,
  mode: type === "OBSERVE_START" || type === "OBSERVE_SET_MODE" ? session.mode : "off",
  sessionEpoch: session.sessionEpoch,
  issuedAt,
  expiresAt: issuedAt + TTL_MS,
  nonce: nonce(),
  ...overrides,
});

/** The worker's boot and the job's tab, through the job-status round trip the journal uses. */
const discover = async (visual, name, jobId) => {
  const reply = await visual.jobStatus(name, [jobId]);
  return { bootId: reply.bootId, targetId: reply.jobs[0]?.targetId };
};

export const createObserve = ({ links, visual, now = Date.now }) => {
  const sessions = new Map();
  const telemetry = new Map();
  const replies = createReplies({ ttlMs: TTL_MS });

  const eventsOf = (name) => {
    if (!telemetry.has(name)) {
      const renewals = { ok: 0, refused: {} };
      telemetry.set(name, { heartbeats: [], errors: [], renewals, restarts: [] });
    }
    return telemetry.get(name);
  };

  const onTelemetry = (name, message) => {
    const events = eventsOf(name);
    if (message.type === "VISUAL_ERROR") events.errors.push(message);
    if (message.type !== "VISUAL_HEARTBEAT") return;
    events.heartbeats.push(message);
    if (events.heartbeats.length > KEEP) events.heartbeats.shift();
    const session = sessions.get(name);
    // The worker ended this session: its frames stop being shown now, not at the next renewal.
    if (message.state === "ENDED" && session?.sessionEpoch === message.sessionEpoch) {
      session.endedReason = message.reason;
      visual.endSession(name, "ended");
    }
  };

  const closed = (name, channel) => {
    replies.closed(channel);
    const session = sessions.get(name);
    if (session?.channel !== channel) return;
    halt(session);
    visual.endSession(name, "disconnected");
  };

  const listen = (name) => {
    const { channel } = links.get(name);
    if (channel.observed) return;
    channel.observed = true;
    channel.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.type?.endsWith("-reply")) replies.settle(message.requestId, message);
      else onTelemetry(name, message);
    });
    channel.addEventListener("close", () => closed(name, channel));
  };

  const send = (name, request) => {
    listen(name);
    const { channel } = links.get(name);
    const reply = replies.wait(channel, request.requestId);
    channel.send(JSON.stringify(request));
    return reply;
  };

  /** Fields of a request in `name`'s session; `overrides` replace any of them before signing. */
  const signed = (name, type, overrides = {}) =>
    sign(requestOf(sessions.get(name), type, now(), overrides));

  // No renewal and no pending restart outlive the session's stop, close, or replacement.
  function halt(session) {
    if (!session) return;
    clearInterval(session.renew);
    clearTimeout(session.restart);
    session.renew = null;
    session.restart = null;
  }

  const refusedRenewal = (name, session, code) => {
    const { renewals } = eventsOf(name);
    renewals.refused[code] = (renewals.refused[code] ?? 0) + 1;
    halt(session);
    visual.endSession(name, "refused");
    if (!FINAL.has(code) && !FINAL.has(session.endedReason)) restart(name, session);
  };

  // One renewal in flight at a time; a refused one ends the session and may start a fresh one.
  const renew = async (name, session) => {
    if (session.renewing) return;
    session.renewing = true;
    try {
      const reply = await send(name, await signed(name, "OBSERVE_STATUS"));
      if (sessions.get(name) !== session || !session.renew) return;
      if (!reply.ok) return refusedRenewal(name, session, reply.code);
      eventsOf(name).renewals.ok += 1;
      visual.renewed(name);
    } finally {
      session.renewing = false;
    }
  };

  /** A fresh signed start after a lapse, with bounded backoff, never past the owner's grant. */
  function restart(name, session) {
    const { restarts } = eventsOf(name);
    const attempt = session.attempt ?? 0;
    if (attempt >= RESTART_MS.length || now() + RESTART_MS[attempt] > session.grantUntil) {
      restarts.push({ at: now(), gaveUp: true });
      return;
    }
    session.restart = setTimeout(() => {
      restarts.push({ at: now(), attempt: attempt + 1 });
      const { jobId, mode, workerId, grantUntil } = session;
      const next = { jobId, mode, workerId, grantUntil, attempt: attempt + 1 };
      void begin(name, next).catch(() => undefined);
    }, RESTART_MS[attempt]);
  }

  /** `wanted`: jobId, mode, workerId, the owner's grantUntil, and the restart attempt. */
  async function begin(name, wanted) {
    halt(sessions.get(name));
    const { jobId } = wanted;
    const { bootId, targetId } = await discover(visual, name, jobId);
    const previous = sessions.get(name)?.sessionEpoch ?? 0;
    const sessionEpoch = Math.max(now(), previous + 1);
    const { channel } = links.get(name);
    const session = { ...wanted, bootId, targetId, sessionEpoch, channel };
    sessions.set(name, session);
    // Frames may beat the reply: the view holds them until the worker accepts.
    visual.beginSession(name, { bootId, jobId, targetId, sessionEpoch });
    const reply = await send(name, await signed(name, "OBSERVE_START"));
    if (sessions.get(name) !== session) return reply;
    if (!reply.ok) {
      visual.endSession(name, "refused");
      if (wanted.attempt && !FINAL.has(reply.code)) restart(name, session);
      return reply;
    }
    session.attempt = 0;
    visual.acceptSession(name);
    session.renew = setInterval(() => void renew(name, session).catch(() => undefined), RENEW_MS);
    return reply;
  }

  const observeStart = (name, jobId, mode, workerId = links.get(name).proven?.workerId) =>
    begin(name, { jobId, mode, workerId, attempt: 0, grantUntil: now() + GRANT_MS });

  const observeMode = async (name, mode) => {
    sessions.get(name).mode = mode;
    return send(name, await signed(name, "OBSERVE_SET_MODE"));
  };

  const observeStop = async (name) => {
    const session = sessions.get(name);
    halt(session);
    if (session) session.endedReason = "STOPPED";
    const reply = await send(name, await signed(name, "OBSERVE_STOP"));
    visual.endSession(name, "stopped");
    return reply;
  };

  return {
    observeStart,
    observeMode,
    observeStop,
    observeStatus: async (name) => send(name, await signed(name, "OBSERVE_STATUS")),
    observeSigned: signed,
    observeSendRaw: send,
    observeEvents: (name) => eventsOf(name),
    observeSession: (name) => {
      const {
        renew: _timer,
        restart: _restart,
        channel: _channel,
        ...session
      } = sessions.get(name) ?? {};
      return session;
    },
    observePending: () => replies.size(),
    signFields: sign,
  };
};

// W6 slice C: the master's signed observe requests, its lease renewals, and the worker's telemetry.
import { sign } from "./jobs.js";

const TTL_MS = 10_000;
const RENEW_MS = 1_000;
const KEEP = 50;

/** The reply that answers `requestId`, whatever its type. */
const replyTo = (channel, requestId) =>
  new Promise((resolve) => {
    const listener = ({ data }) => {
      const message = JSON.parse(data);
      if (message.requestId !== requestId || !message.type?.endsWith("-reply")) return;
      channel.removeEventListener("message", listener);
      resolve(message);
    };
    channel.addEventListener("message", listener);
  });

const nonce = () => crypto.randomUUID().replaceAll("-", "");

export const createObserve = ({ links, visual }) => {
  const sessions = new Map();
  const telemetry = new Map();

  const eventsOf = (name) => {
    if (!telemetry.has(name)) {
      telemetry.set(name, { heartbeats: [], errors: [], renewals: { ok: 0, refused: {} } });
    }
    return telemetry.get(name);
  };

  const listen = (name) => {
    const { channel } = links.get(name);
    if (channel.observed) return;
    channel.observed = true;
    channel.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const events = eventsOf(name);
      if (message.type === "VISUAL_HEARTBEAT") events.heartbeats.push(message);
      if (message.type === "VISUAL_ERROR") events.errors.push(message);
      if (events.heartbeats.length > KEEP) events.heartbeats.shift();
    });
  };

  const send = (name, request) => {
    const { channel } = links.get(name);
    const reply = replyTo(channel, request.requestId);
    channel.send(JSON.stringify(request));
    return reply;
  };

  /** Fields of a request in `name`'s session; `overrides` replace any of them before signing. */
  const signed = (name, type, overrides = {}) => {
    const session = sessions.get(name);
    const issuedAt = Date.now();
    const mode = type === "OBSERVE_START" || type === "OBSERVE_SET_MODE" ? session.mode : "off";
    return sign({
      type,
      requestId: crypto.randomUUID(),
      workerId: session.workerId,
      bootId: session.bootId,
      jobId: session.jobId,
      targetId: session.targetId,
      mode,
      sessionEpoch: session.sessionEpoch,
      issuedAt,
      expiresAt: issuedAt + TTL_MS,
      nonce: nonce(),
      ...overrides,
    });
  };

  const stopRenewing = (name) => clearInterval(sessions.get(name)?.renew);

  // A refused renewal means the worker ended the session: the master stops asking.
  const renew = async (name) => {
    const reply = await send(name, await signed(name, "OBSERVE_STATUS"));
    const { renewals } = eventsOf(name);
    if (reply.ok) renewals.ok += 1;
    else {
      renewals.refused[reply.code] = (renewals.refused[reply.code] ?? 0) + 1;
      stopRenewing(name);
    }
  };

  /** The worker's boot and the job's tab, through the job-status round trip the journal uses. */
  const discover = async (name, jobId) => {
    const reply = await visual.jobStatus(name, [jobId]);
    return { bootId: reply.bootId, targetId: reply.jobs[0]?.targetId };
  };

  const observeStart = async (name, jobId, mode, workerId = links.get(name).proven?.workerId) => {
    listen(name);
    stopRenewing(name);
    const { bootId, targetId } = await discover(name, jobId);
    const previous = sessions.get(name)?.sessionEpoch ?? 0;
    const sessionEpoch = Math.max(Date.now(), previous + 1);
    sessions.set(name, { workerId, bootId, jobId, targetId, mode, sessionEpoch });
    // Admitted before the request leaves: the first frame may beat the reply.
    visual.beginSession(name, { bootId, jobId });
    const reply = await send(name, await signed(name, "OBSERVE_START"));
    if (!reply.ok) {
      visual.endSession(name);
      return reply;
    }
    sessions.get(name).renew = setInterval(() => void renew(name).catch(() => undefined), RENEW_MS);
    return reply;
  };

  const observeMode = async (name, mode) => {
    sessions.get(name).mode = mode;
    return send(name, await signed(name, "OBSERVE_SET_MODE"));
  };

  const observeStop = async (name) => {
    stopRenewing(name);
    const reply = await send(name, await signed(name, "OBSERVE_STOP"));
    visual.endSession(name);
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
      const { renew: _timer, ...session } = sessions.get(name) ?? {};
      return session;
    },
    signFields: sign,
  };
};

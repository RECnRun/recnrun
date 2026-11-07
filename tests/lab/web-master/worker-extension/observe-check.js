// W6 slice C: an observe request is the pinned master's, fresh, once, for this job's tab and session.
import { signatureValid } from "./job-check.js";
import { requestError } from "./observe-schema.js";

const CLOCK_SKEW_MS = 30_000;
const RATE = { max: 20, windowMs: 10_000 };

const epochError = (message, { session, highestEpoch }) => {
  if (message.type === "OBSERVE_START") {
    return message.sessionEpoch > highestEpoch ? null : "OLD_EPOCH";
  }
  if (session && message.sessionEpoch === session.sessionEpoch) return null;
  return message.sessionEpoch < highestEpoch ? "OLD_EPOCH" : "NO_SESSION";
};

const jobError = async (message, { job, finished }) => {
  if (!job || job.jobId !== message.jobId) {
    return (await finished(message.jobId)) ? "JOB_FINISHED" : "UNKNOWN_JOB";
  }
  return job.targetId === message.targetId ? null : "WRONG_TARGET";
};

export const createObserveCheck = ({ now = Date.now, rate = RATE } = {}) => {
  const recent = [];
  // requestIds and nonces seen, each kept until its request expires.
  const seen = new Map();

  const limited = () => {
    const at = now();
    while (recent.length > 0 && recent[0] <= at - rate.windowMs) recent.shift();
    recent.push(at);
    return recent.length > rate.max;
  };

  const replayed = (message) => {
    for (const [value, until] of seen) if (until < now()) seen.delete(value);
    if (seen.has(message.requestId) || seen.has(message.nonce)) return true;
    seen.set(message.requestId, message.expiresAt);
    seen.set(message.nonce, message.expiresAt);
    return false;
  };

  const clockError = (message) => {
    if (message.issuedAt > now() + CLOCK_SKEW_MS) return "INVALID_REQUEST";
    return now() > message.expiresAt ? "EXPIRED" : null;
  };

  const identityError = (message, context) => {
    if (message.workerId !== context.workerId) return "WRONG_WORKER";
    if (message.bootId !== context.bootId) return "OLD_BOOT";
    return replayed(message) ? "REPLAY" : null;
  };

  /** Null when the request may act, otherwise the refusal code. */
  const check = async (message, context) => {
    if (limited()) return "RATE_LIMITED";
    const shape = requestError(message) ?? clockError(message);
    if (shape) return shape;
    // The pinned key is checked before the request may consume its id or nonce.
    if (!(await signatureValid(message, context.masterKey))) return "UNPINNED_MASTER";
    return (
      identityError(message, context) ??
      (await jobError(message, context)) ??
      epochError(message, context)
    );
  };

  return { check };
};

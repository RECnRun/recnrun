// W7 slice A: a start is the pinned master's, over a nonce this worker issued on this very link.
import { allows } from "./allow.js";
import { inputError } from "./input-schema.js";
import { signatureValid } from "./job-check.js";
import { originOf } from "./job-schema.js";

const NONCE_TTL_MS = 30_000;
const MAX_OUTSTANDING = 16;
const CLOCK_SKEW_MS = 30_000;

const freshNonce = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
};

export const createStartCheck = ({ now = Date.now } = {}) => {
  /** @type {Map<string, { linkId: string, until: number }>} nonces issued and not yet spent */
  const issued = new Map();
  /** @type {Map<string, number>} spent nonces, kept until no start naming them can be fresh */
  const spent = new Map();

  const prune = () => {
    for (const [nonce, entry] of issued) if (entry.until < now()) issued.delete(nonce);
    for (const [nonce, until] of spent) if (until < now()) spent.delete(nonce);
  };

  /** A fresh nonce bound to `linkId`, or null while too many are outstanding. */
  const issue = (linkId) => {
    prune();
    if (issued.size >= MAX_OUTSTANDING) return null;
    const nonce = freshNonce();
    issued.set(nonce, { linkId, until: now() + NONCE_TTL_MS });
    return nonce;
  };

  const forget = (linkId) => {
    for (const [nonce, entry] of issued) if (entry.linkId === linkId) issued.delete(nonce);
  };

  const clockError = (message) => {
    if (message.iat > now() + CLOCK_SKEW_MS) return "INVALID_REQUEST";
    return now() > message.exp ? "EXPIRED" : null;
  };

  const identityError = (message, context) => {
    if (message.workerId !== context.workerId) return "WRONG_WORKER";
    return message.bootId === context.bootId ? null : "OLD_BOOT";
  };

  // The fingerprints the master signed must be this link's; its nonce must come from this link.
  const linkError = (message, link) => {
    if (message.masterFingerprint !== link.masterFingerprint) return "LINK_MISMATCH";
    if (message.workerFingerprint !== link.workerFingerprint) return "LINK_MISMATCH";
    const entry = issued.get(message.nonce);
    if (!entry) return spent.has(message.nonce) ? "REPLAY" : "NONCE_UNKNOWN";
    return entry.linkId === link.linkId ? null : "LINK_MISMATCH";
  };

  /** Null when the start may claim the worker, otherwise the refusal; a bound start spends its nonce. */
  const check = async (message, context) => {
    prune();
    const shape =
      inputError(message) ?? (message.type === "INTERACT_START" ? null : "INVALID_REQUEST");
    const early = shape ?? clockError(message);
    if (early) return early;
    // The pinned key is checked before the start may spend its nonce.
    if (!(await signatureValid(message, context.masterKey))) return "BAD_SIGNATURE";
    const refused = identityError(message, context) ?? linkError(message, context.link);
    if (refused) return refused;
    spent.set(message.nonce, Math.max(issued.get(message.nonce).until, message.exp));
    issued.delete(message.nonce);
    return allows(context.allowlist, originOf(message.url)) ? null : "ORIGIN_DENIED";
  };

  return { issue, check, forget, sizes: () => ({ issued: issued.size, spent: spent.size }) };
};

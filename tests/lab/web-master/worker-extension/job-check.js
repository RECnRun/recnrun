// Strict job check of plan §6 (lab subset): schema, clock, origins, signature.
import { canonical } from "./encoding.js";
import { envelopeError, opError, originOf } from "./job-schema.js";

const CLOCK_SKEW_MS = 30_000;
const MAX_JOB_MS = 600_000;

// A future issuedAt would stretch the 10-minute cap; the cap holds against the worker's clock.
const clockError = (job, now) => {
  if (job.issuedAt > now + CLOCK_SKEW_MS) return "INVALID_COMMAND";
  return job.deadlineAt - now > MAX_JOB_MS ? "INVALID_COMMAND" : null;
};

const originsError = (job, allowlist) => {
  const valid = Array.isArray(job.origins) && job.origins.length >= 1 && job.origins.length <= 8;
  if (!valid) return "INVALID_COMMAND";
  return job.origins.every((origin) => allowlist.includes(origin)) ? null : "FORBIDDEN_ORIGIN";
};

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const signatureValid = async (job, masterJwk) => {
  const { signature, ...fields } = job;
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const key = await crypto.subtle.importKey("jwk", masterJwk, algorithm, false, ["verify"]);
  const data = new TextEncoder().encode(canonical(fields));
  const ecdsa = { name: "ECDSA", hash: "SHA-256" };
  // A signature that is not base64 is a bad signature, not a crash of the admission path.
  return Promise.resolve()
    .then(() => crypto.subtle.verify(ecdsa, key, fromBase64(signature), data))
    .catch(() => false);
};

/** Null when the job may be accepted, otherwise the refusal code. */
export const checkJob = async (job, { masterKey, allowlist }) => {
  const error =
    envelopeError(job) ??
    clockError(job, Date.now()) ??
    originsError(job, allowlist) ??
    job.ops.map((entry) => opError(entry, job.origins)).find(Boolean) ??
    null;
  if (error) return error;
  if (Date.now() > job.deadlineAt + 5_000) return "EXPIRED";
  // The pinned key is the only one the worker knows: any other signer is an unpinned master.
  return (await signatureValid(job, masterKey)) ? null : "UNPINNED_MASTER";
};

export const digestOf = async (job) => {
  const bytes = new TextEncoder().encode(canonical(job));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const originOfUrl = originOf;

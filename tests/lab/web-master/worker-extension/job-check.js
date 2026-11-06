// Strict job check of plan §6 (lab subset): exact keys, the five ops, limits, origins, signature.
const TOP = ["deadlineAt", "epoch", "issuedAt", "jobId", "ops", "origins", "signature", "tabRef"];
const ARGS = {
  navigate: ["url"],
  wait: ["selector", "state"],
  type: ["selector", "text"],
  click: ["selector"],
  read: ["maxBytes", "selector", "what"],
};
const MAX_OPS = 32;
const MAX_OP_MS = 30_000;
const MAX_JOB_MS = 600_000;
const MAX_JOB_BYTES = 65_536;

export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys) =>
  isObject(value) && Object.keys(value).sort().join() === keys.join();
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

const urlError = (url, origins) => {
  if (typeof url !== "string" || url.length > 2048 || !/^https?:\/\//.test(url)) {
    return "INVALID_COMMAND";
  }
  return origins.includes(originOf(url)) ? null : "FORBIDDEN_ORIGIN";
};

const opError = (entry, origins) => {
  if (!hasKeys(entry, ["args", "op", "timeoutMs"])) return "INVALID_COMMAND";
  const keys = Object.hasOwn(ARGS, entry.op) ? ARGS[entry.op] : null;
  if (!keys || !hasKeys(entry.args, keys)) return "INVALID_COMMAND";
  const timeout = entry.timeoutMs;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_OP_MS) return "INVALID_COMMAND";
  return entry.op === "navigate" ? urlError(entry.args.url, origins) : null;
};

const shapeError = (job) => {
  if (!hasKeys(job, TOP) || typeof job.jobId !== "string") return "INVALID_COMMAND";
  if (canonical(job).length > MAX_JOB_BYTES) return "INVALID_COMMAND";
  if (!Array.isArray(job.ops) || job.ops.length < 1 || job.ops.length > MAX_OPS) {
    return "INVALID_COMMAND";
  }
  const span = job.deadlineAt - job.issuedAt;
  return Number.isInteger(span) && span > 0 && span <= MAX_JOB_MS ? null : "INVALID_COMMAND";
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
  return crypto.subtle.verify(ecdsa, key, fromBase64(String(signature)), data).catch(() => false);
};

/** Null when the job may be accepted, otherwise the refusal code. */
export const checkJob = async (job, { masterKey, allowlist }) => {
  const error =
    shapeError(job) ??
    originsError(job, allowlist) ??
    job.ops.map((entry) => opError(entry, job.origins)).find(Boolean) ??
    null;
  if (error) return error;
  if (Date.now() > job.deadlineAt + 5_000) return "EXPIRED";
  return (await signatureValid(job, masterKey)) ? null : "BAD_SIGNATURE";
};

export const digestOf = async (job) => {
  const bytes = new TextEncoder().encode(canonical(job));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const originOfUrl = originOf;

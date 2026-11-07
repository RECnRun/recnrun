// Closed job schema of plan §6 (lab subset): exact keys, typed fields, UTF-8 byte caps, five ops.
import { canonical, utf8Length } from "./encoding.js";

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
const MAX_SELECTOR = 512;
const MAX_TEXT = 4096;
const MAX_URL = 2048;
const MAX_READ_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB_REF = /^[A-Za-z0-9_-]{1,64}$/;
const INVALID = "INVALID_COMMAND";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys) =>
  isObject(value) && Object.keys(value).sort().join() === keys.join();
export const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

const bounded = (value, max) => typeof value === "string" && utf8Length(value) <= max;
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;

const FIELD_VALID = {
  jobId: (value) => typeof value === "string" && UUID.test(value),
  epoch: (value) => Number.isSafeInteger(value) && value >= 0,
  issuedAt: timestamp,
  deadlineAt: timestamp,
  tabRef: (value) => typeof value === "string" && TAB_REF.test(value),
  signature: (value) => bounded(value, 256) && value.length > 0,
  origins: (value) => Array.isArray(value) && value.every((origin) => typeof origin === "string"),
  ops: (value) => Array.isArray(value) && value.length >= 1 && value.length <= MAX_OPS,
};

/** Envelope shape: exact keys, field types, 64 KiB of UTF-8, and a deadline within 10 minutes. */
export const envelopeError = (job) => {
  if (!hasKeys(job, TOP)) return INVALID;
  if (!Object.entries(FIELD_VALID).every(([key, valid]) => valid(job[key]))) return INVALID;
  if (utf8Length(canonical(job)) > MAX_JOB_BYTES) return INVALID;
  const span = job.deadlineAt - job.issuedAt;
  return span > 0 && span <= MAX_JOB_MS ? null : INVALID;
};

// Only the variants the worker implements: a master cannot select behavior that is not there.
const ARG_VALID = {
  selector: (value) => bounded(value, MAX_SELECTOR) && value.length > 0,
  text: (value) => bounded(value, MAX_TEXT),
  maxBytes: (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_READ_BYTES,
  state: (value) => value === "attached",
  what: (value) => value === "text",
  url: () => true,
};

const argsValid = (args) => Object.entries(args).every(([key, value]) => ARG_VALID[key](value));

const urlError = (url, origins) => {
  if (!bounded(url, MAX_URL) || !/^https?:\/\//.test(url)) return INVALID;
  return origins.includes(originOf(url)) ? null : "FORBIDDEN_ORIGIN";
};

export const opError = (entry, origins) => {
  if (!hasKeys(entry, ["args", "op", "timeoutMs"])) return INVALID;
  const keys = Object.hasOwn(ARGS, entry.op) ? ARGS[entry.op] : null;
  if (!keys || !hasKeys(entry.args, keys) || !argsValid(entry.args)) return INVALID;
  const timeout = entry.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_OP_MS) return INVALID;
  return entry.op === "navigate" ? urlError(entry.args.url, origins) : null;
};

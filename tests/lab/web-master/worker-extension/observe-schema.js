// W6 slice C: the closed observe request. Exact keys and enums: no code, URL, or selector fits.
import { canonical, utf8Length } from "./encoding.js";

export const OBSERVE_TYPES = [
  "OBSERVE_START",
  "OBSERVE_STOP",
  "OBSERVE_SET_MODE",
  "OBSERVE_STATUS",
];
const KEYS = [
  "bootId",
  "expiresAt",
  "issuedAt",
  "jobId",
  "mode",
  "nonce",
  "requestId",
  "sessionEpoch",
  "signature",
  "targetId",
  "type",
  "workerId",
];
// A start or a mode change names a capture mode; a stop or a status names none.
const MODES = {
  OBSERVE_START: ["thumbnail", "live"],
  OBSERVE_SET_MODE: ["thumbnail", "live"],
  OBSERVE_STOP: ["off"],
  OBSERVE_STATUS: ["off"],
};
const MAX_TTL_MS = 30_000;
const MAX_BYTES = 2_048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID = "INVALID_REQUEST";

const uuid = (value) => typeof value === "string" && UUID.test(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const FIELD_VALID = {
  requestId: uuid,
  bootId: uuid,
  jobId: uuid,
  workerId: (value) => typeof value === "string" && /^[a-p]{32}$/.test(value),
  targetId: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
  sessionEpoch: (value) => Number.isSafeInteger(value) && value > 0,
  issuedAt: timestamp,
  expiresAt: timestamp,
  nonce: (value) => typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value),
  signature: (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
};

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Null for a well-formed request, otherwise INVALID_REQUEST. */
export const requestError = (message) => {
  if (!isObject(message) || Object.keys(message).sort().join() !== KEYS.join()) return INVALID;
  if (!Object.hasOwn(MODES, message.type) || !MODES[message.type].includes(message.mode)) {
    return INVALID;
  }
  if (!Object.entries(FIELD_VALID).every(([key, valid]) => valid(message[key]))) return INVALID;
  if (utf8Length(canonical(message)) > MAX_BYTES) return INVALID;
  const ttl = message.expiresAt - message.issuedAt;
  return ttl > 0 && ttl <= MAX_TTL_MS ? null : INVALID;
};

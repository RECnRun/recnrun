// W7 slice A: the closed input.v1 messages. Exact keys and enums: no code, selector, or method fits.
import { canonical, utf8Length } from "./encoding.js";

export const INPUT_TYPES = [
  "INTERACT_CHALLENGE",
  "INTERACT_START",
  "INTERACT_RENEW",
  "INTERACT_STOP",
  "INPUT_EVENT",
];
// The kinds the worker knows; slices B and C give each its fields and its dispatch.
const EVENT_KINDS = ["pointerMove", "pointerDown", "pointerUp", "wheel", "key", "text"];
const KEYS = {
  INTERACT_CHALLENGE: ["requestId", "type"],
  INTERACT_START: [
    "bootId",
    "exp",
    "iat",
    "masterFingerprint",
    "nonce",
    "requestId",
    "signature",
    "type",
    "url",
    "workerFingerprint",
    "workerId",
  ],
  INTERACT_RENEW: ["leaseId", "seq", "type"],
  INTERACT_STOP: ["leaseId", "seq", "type"],
  INPUT_EVENT: ["kind", "leaseId", "seq", "type"],
};
const MAX_TTL_MS = 30_000;
const MAX_BYTES = 8_192;
const MAX_URL = 2_048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const INVALID = "INVALID_REQUEST";

const uuid = (value) => typeof value === "string" && UUID.test(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const fingerprint = (value) => typeof value === "string" && FINGERPRINT.test(value);
const FIELD_VALID = {
  type: () => true,
  requestId: uuid,
  leaseId: uuid,
  bootId: uuid,
  workerId: (value) => typeof value === "string" && /^[a-p]{32}$/.test(value),
  nonce: (value) => typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value),
  masterFingerprint: fingerprint,
  workerFingerprint: fingerprint,
  url: (value) =>
    typeof value === "string" && value.length <= MAX_URL && /^https?:\/\//.test(value),
  iat: timestamp,
  exp: timestamp,
  seq: (value) => Number.isSafeInteger(value) && value >= 1,
  kind: (value) => EVENT_KINDS.includes(value),
  signature: (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
};

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Null for a well-formed input.v1 message, otherwise INVALID_REQUEST. */
export const inputError = (message) => {
  if (!isObject(message) || !Object.hasOwn(KEYS, message.type)) return INVALID;
  const keys = KEYS[message.type];
  if (Object.keys(message).sort().join() !== keys.join()) return INVALID;
  if (!keys.every((key) => FIELD_VALID[key](message[key]))) return INVALID;
  if (utf8Length(canonical(message)) > MAX_BYTES) return INVALID;
  if (message.type !== "INTERACT_START") return null;
  const ttl = message.exp - message.iat;
  return ttl > 0 && ttl <= MAX_TTL_MS ? null : INVALID;
};

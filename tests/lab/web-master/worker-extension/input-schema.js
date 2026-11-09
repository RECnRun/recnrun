// W7 slice A: the closed input.v1 messages. Exact keys and enums: no code, selector, or method fits.
import { canonical, utf8Length } from "./encoding.js";
import { POINTER_KINDS } from "./interact-frames.js";

export const INPUT_TYPES = [
  "INTERACT_CHALLENGE",
  "INTERACT_START",
  "INTERACT_RENEW",
  "INTERACT_STOP",
  "INTERACT_REFRESH",
  "INTERACT_VIEWPORT",
  "INPUT_EVENT",
];
// The kinds the worker knows; slices B and C give each its fields and its dispatch.
// W7 slice D: a hold tells the dead man the master is there; it names the frame it shows (W7 fixes).
const EVENT_KINDS = ["pointerMove", "pointerDown", "pointerUp", "wheel", "key", "text", "hold"];
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
  INTERACT_REFRESH: ["leaseId", "seq", "type"],
  INTERACT_VIEWPORT: ["height", "leaseId", "seq", "type", "width"],
  INPUT_EVENT: ["kind", "leaseId", "seq", "type"],
};
// W7 slice B: a pointer names the frame it was aimed at and a point over that frame's image.
const POINTER_KEYS = [
  "bootId",
  "button",
  "clickCount",
  "frameSeq",
  "kind",
  "leaseId",
  "loaderId",
  "modifiers",
  "seq",
  "sessionEpoch",
  "type",
  "x",
  "y",
];
// W7 slice C: a key, a text, and a wheel name the frame too; only a wheel names a point.
const AIMED = ["bootId", "frameSeq", "kind", "leaseId", "loaderId", "seq", "sessionEpoch", "type"];
const KIND_KEYS = {
  hold: [...AIMED].sort(),
  key: [...AIMED, "code", "modifiers", "phase"].sort(),
  text: [...AIMED, "text"].sort(),
  wheel: [...AIMED, "deltaX", "deltaY", "modifiers", "x", "y"].sort(),
};
const MAX_DELTA = 10_000;
const BUTTONS = ["none", "left", "middle", "right"];
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
  x: (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  y: (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  button: (value) => BUTTONS.includes(value),
  clickCount: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 3,
  modifiers: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 15,
  frameSeq: (value) => Number.isSafeInteger(value) && value >= 1,
  sessionEpoch: timestamp,
  loaderId: (value) => typeof value === "string" && /^[0-9A-Za-z]{1,64}$/.test(value),
  // Any short name: a well-formed code outside the table is refused as unsupported, not invalid.
  code: (value) => typeof value === "string" && /^[A-Za-z0-9]{1,32}$/.test(value),
  phase: (value) => value === "down" || value === "up",
  // Control characters are keys, never text; the 4 KiB cap is the dispatch's own refusal.
  text: (value) => typeof value === "string" && value.length > 0 && !hasControl(value),
  deltaX: (value) => Number.isFinite(value) && Math.abs(value) <= MAX_DELTA,
  deltaY: (value) => Number.isFinite(value) && Math.abs(value) <= MAX_DELTA,
  // Any number, or the null a NaN serializes to: the clamp answers INPUT_INVALID for a non-integer.
  width: (value) => typeof value === "number" || value === null,
  height: (value) => typeof value === "number" || value === null,
  signature: (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
};

const hasControl = (text) => [...text].some((char) => char < " " || char === "\u007f");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const keysOf = (message) => {
  if (message.type !== "INPUT_EVENT") return KEYS[message.type];
  if (POINTER_KINDS.includes(message.kind)) return POINTER_KEYS;
  return Object.hasOwn(KIND_KEYS, message.kind) ? KIND_KEYS[message.kind] : KEYS.INPUT_EVENT;
};

/** Null for a well-formed input.v1 message, otherwise INVALID_REQUEST. */
export const inputError = (message) => {
  if (!isObject(message) || !Object.hasOwn(KEYS, message.type)) return INVALID;
  const keys = keysOf(message);
  if (Object.keys(message).sort().join() !== keys.join()) return INVALID;
  if (!keys.every((key) => FIELD_VALID[key](message[key]))) return INVALID;
  if (utf8Length(canonical(message)) > MAX_BYTES) return INVALID;
  if (message.type !== "INTERACT_START") return null;
  const ttl = message.exp - message.iat;
  return ttl > 0 && ttl <= MAX_TTL_MS ? null : INVALID;
};

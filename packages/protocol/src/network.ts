import * as v from "valibot";
import { CountSchema, NonEmptyStringSchema } from "./common.ts";
import { typedEvent } from "./events.ts";

/** What became of a response body: kept whole, kept in part, lost, or never asked for. */
export const BODY_CONDITIONS = ["captured", "truncated", "unavailable", "not-requested"] as const;

/** Response bodies longer than this many characters are kept in part and marked `truncated`. */
export const MAX_INLINE_BODY_LENGTH = 65_536;

/** Bodies stored as blobs keep at most this many bytes unless the caller sets another cap. */
export const DEFAULT_MAX_BLOB_BYTES = 1_048_576;

/** Header values longer than this are clipped, and the event says `headersTruncated`. */
export const MAX_HEADER_VALUE_LENGTH = 4_096;

/** WebSocket frame payloads longer than this many characters are kept in part and flagged. */
export const MAX_FRAME_PAYLOAD_LENGTH = 4_096;

/** What replaces the value of a sensitive header before anything is persisted. */
export const REDACTED = "redacted";

/** Headers whose values are always redacted, by lowercase name; a session can add more. */
export const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
] as const;

/** Where a response came from: the network, or one of Chrome's caches. */
export const CACHE_STATES = ["network", "memory", "disk", "service-worker", "prefetch"] as const;

/** How the bytes of a stored body read: UTF-8 text, or raw bytes Chrome delivered as base64. */
export const BODY_ENCODINGS = ["utf8", "binary"] as const;

/** How a WebSocket frame payload is written in the event: as text, or base64 for binary frames. */
export const FRAME_ENCODINGS = ["utf8", "base64"] as const;

const SHA256 = /^[0-9a-f]{64}$/;
const StatusSchema = v.pipe(v.number(), v.integer());

export const BodyConditionSchema = v.picklist(BODY_CONDITIONS);
export const CacheStateSchema = v.picklist(CACHE_STATES);
export const Sha256Schema = v.pipe(v.string(), v.regex(SHA256, "A blob is named by its sha256."));

/** True for a lowercase sha256 hex digest, the only name a blob file can have. */
export const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && SHA256.test(value);

/** Header names and values, with sensitive values already `redacted` and long ones clipped. */
export const HeadersSchema = v.record(
  v.string(),
  v.pipe(v.string(), v.maxLength(MAX_HEADER_VALUE_LENGTH)),
);

const timingEntry = v.optional(v.number());

/** Chrome's resource timing: `requestTime` in seconds, the rest in ms after it (-1 when absent). */
export const ResourceTimingSchema = v.strictObject({
  requestTime: timingEntry,
  proxyStart: timingEntry,
  proxyEnd: timingEntry,
  dnsStart: timingEntry,
  dnsEnd: timingEntry,
  connectStart: timingEntry,
  connectEnd: timingEntry,
  sslStart: timingEntry,
  sslEnd: timingEntry,
  workerStart: timingEntry,
  workerReady: timingEntry,
  sendStart: timingEntry,
  sendEnd: timingEntry,
  receiveHeadersStart: timingEntry,
  receiveHeadersEnd: timingEntry,
});

/** A body stored as a blob: its sha256 names the bytes kept; `size` is the whole body in bytes. */
export const BodyRefSchema = v.strictObject({
  sha256: Sha256Schema,
  mime: v.string(),
  encoding: v.picklist(BODY_ENCODINGS),
  size: CountSchema,
  condition: v.picklist(["captured", "truncated"]),
});

/** A hop of a redirect chain: the URL that answered with a redirect status. */
export const RedirectHopSchema = v.strictObject({
  url: v.string(),
  method: NonEmptyStringSchema,
  status: StatusSchema,
});

/** A response body with its condition; `reason` says why it is not `captured`. */
export const BodyPayloadSchema = v.strictObject({
  requestId: NonEmptyStringSchema,
  url: v.string(),
  condition: BodyConditionSchema,
  mimeType: v.optional(v.string()),
  // An inline body's length in characters (base64 characters when `base64Encoded`).
  size: v.optional(CountSchema),
  base64Encoded: v.optional(v.boolean()),
  body: v.optional(v.pipe(v.string(), v.maxLength(MAX_INLINE_BODY_LENGTH))),
  // Set instead of `body` when the capture stores bodies as blobs.
  blob: v.optional(BodyRefSchema),
  reason: v.optional(NonEmptyStringSchema),
});

const headerEntries = {
  headers: v.optional(HeadersSchema),
  headersTruncated: v.optional(v.literal(true)),
};

const requestId = NonEmptyStringSchema;

/** One WebSocket frame, its payload clipped to `MAX_FRAME_PAYLOAD_LENGTH` and flagged when it was. */
export const WebSocketFramePayloadSchema = v.strictObject({
  requestId,
  direction: v.picklist(["sent", "received"]),
  opcode: CountSchema,
  encoding: v.picklist(FRAME_ENCODINGS),
  payload: v.pipe(v.string(), v.maxLength(MAX_FRAME_PAYLOAD_LENGTH)),
  // The whole payload's length in characters, as Chrome delivered it.
  size: CountSchema,
  truncated: v.boolean(),
});

/** The network events of the capture: HTTP requests with their bodies, and WebSocket frames. */
export const NetworkEventSchema = v.variant("type", [
  typedEvent(
    "network",
    "request",
    v.strictObject({
      requestId,
      url: v.string(),
      method: NonEmptyStringSchema,
      resourceType: v.optional(NonEmptyStringSchema),
      redirectChain: v.optional(v.array(RedirectHopSchema)),
      ...headerEntries,
    }),
  ),
  typedEvent(
    "network",
    "response",
    v.strictObject({
      requestId,
      url: v.string(),
      status: StatusSchema,
      statusText: v.string(),
      mimeType: v.string(),
      fromCache: v.optional(v.boolean()),
      cache: v.optional(CacheStateSchema),
      timing: v.optional(ResourceTimingSchema),
      ...headerEntries,
    }),
  ),
  typedEvent("network", "finished", v.strictObject({ requestId, encodedDataLength: v.number() })),
  typedEvent(
    "network",
    "failed",
    v.strictObject({
      requestId,
      errorText: v.string(),
      canceled: v.boolean(),
      blockedReason: v.optional(v.string()),
    }),
  ),
  typedEvent("network", "body", BodyPayloadSchema),
  typedEvent("network", "websocket-created", v.strictObject({ requestId, url: v.string() })),
  typedEvent(
    "network",
    "websocket-handshake",
    v.strictObject({ requestId, status: StatusSchema, statusText: v.string(), ...headerEntries }),
  ),
  typedEvent("network", "websocket-frame", WebSocketFramePayloadSchema),
  typedEvent("network", "websocket-error", v.strictObject({ requestId, errorMessage: v.string() })),
  typedEvent("network", "websocket-closed", v.strictObject({ requestId })),
]);

export type BodyCondition = v.InferOutput<typeof BodyConditionSchema>;
export type BodyPayload = v.InferOutput<typeof BodyPayloadSchema>;
export type BodyRef = v.InferOutput<typeof BodyRefSchema>;
export type BodyEncoding = BodyRef["encoding"];
export type CacheState = v.InferOutput<typeof CacheStateSchema>;
export type ResourceTiming = v.InferOutput<typeof ResourceTimingSchema>;
export type WebSocketFramePayload = v.InferOutput<typeof WebSocketFramePayloadSchema>;

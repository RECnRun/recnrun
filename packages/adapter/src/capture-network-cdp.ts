import * as v from "valibot";
import type { Draft } from "./capture-envelope.ts";

// The CDP Network parameters capture reads; anything else Chrome sends is ignored.
const HeadersSchema = v.optional(v.record(v.string(), v.string()));

export const RequestSchema = v.object({
  requestId: v.string(),
  request: v.object({ url: v.string(), method: v.string(), headers: HeadersSchema }),
  type: v.optional(v.string()),
  frameId: v.optional(v.string()),
  redirectResponse: v.optional(v.object({ url: v.string(), status: v.number() })),
});

export const ResponseSchema = v.object({
  requestId: v.string(),
  type: v.optional(v.string()),
  frameId: v.optional(v.string()),
  response: v.object({
    url: v.string(),
    status: v.number(),
    statusText: v.string(),
    mimeType: v.string(),
    headers: HeadersSchema,
    timing: v.optional(v.record(v.string(), v.unknown())),
    fromDiskCache: v.optional(v.boolean()),
    fromServiceWorker: v.optional(v.boolean()),
    fromPrefetchCache: v.optional(v.boolean()),
  }),
});

export const RequestIdSchema = v.object({ requestId: v.string() });

export const FinishedSchema = v.object({ requestId: v.string(), encodedDataLength: v.number() });

export const FailedSchema = v.object({
  requestId: v.string(),
  errorText: v.string(),
  canceled: v.optional(v.boolean()),
  blockedReason: v.optional(v.string()),
});

export const BodySchema = v.object({ body: v.string(), base64Encoded: v.boolean() });

export const WebSocketCreatedSchema = v.object({ requestId: v.string(), url: v.string() });

export const WebSocketHandshakeSchema = v.object({
  requestId: v.string(),
  response: v.object({ status: v.number(), statusText: v.string(), headers: HeadersSchema }),
});

export const WebSocketFrameSchema = v.object({
  requestId: v.string(),
  response: v.object({ opcode: v.number(), payloadData: v.string() }),
});

export const WebSocketErrorSchema = v.object({ requestId: v.string(), errorMessage: v.string() });

export const EventSourceMessageSchema = v.object({
  requestId: v.string(),
  eventName: v.string(),
  eventId: v.string(),
  data: v.string(),
});

export const network = (type: string, payload: Record<string, unknown>): Draft => ({
  category: "network",
  type,
  component: "application",
  payload,
});

import { MAX_FRAME_PAYLOAD_LENGTH } from "@recnrun/protocol";
import * as v from "valibot";
import type { Draft } from "./capture-envelope.ts";
import {
  EventSourceMessageSchema,
  network,
  RequestIdSchema,
  WebSocketCreatedSchema,
  WebSocketErrorSchema,
  WebSocketFrameSchema,
  WebSocketHandshakeSchema,
} from "./capture-network-cdp.ts";
import { headerEntries } from "./capture-network-evidence.ts";

// Text frames (opcode 1) arrive as text; Chrome sends every other payload as base64.
const TEXT_OPCODE = 1;

function frame(direction: "sent" | "received", params: unknown): Draft | undefined {
  const parsed = v.safeParse(WebSocketFrameSchema, params);
  if (!parsed.success) return undefined;
  const { requestId, response } = parsed.output;
  const { opcode, payloadData } = response;
  return network("websocket-frame", {
    requestId,
    direction,
    opcode,
    encoding: opcode === TEXT_OPCODE ? "utf8" : "base64",
    payload: payloadData.slice(0, MAX_FRAME_PAYLOAD_LENGTH),
    size: payloadData.length,
    truncated: payloadData.length > MAX_FRAME_PAYLOAD_LENGTH,
  });
}

function eventSourceMessage(params: unknown): Draft | undefined {
  const parsed = v.safeParse(EventSourceMessageSchema, params);
  if (!parsed.success) return undefined;
  const { requestId, eventName, eventId, data } = parsed.output;
  return network("eventsource-message", {
    requestId,
    eventName,
    eventId,
    data: data.slice(0, MAX_FRAME_PAYLOAD_LENGTH),
    size: data.length,
    truncated: data.length > MAX_FRAME_PAYLOAD_LENGTH,
  });
}

function handshake(params: unknown, sensitive: ReadonlySet<string>): Draft | undefined {
  const parsed = v.safeParse(WebSocketHandshakeSchema, params);
  if (!parsed.success) return undefined;
  const { requestId, response } = parsed.output;
  const { status, statusText, headers } = response;
  return network("websocket-handshake", {
    requestId,
    status,
    statusText,
    ...headerEntries(headers, sensitive),
  });
}

function simple(type: string, schema: v.GenericSchema, params: unknown): Draft | undefined {
  const parsed = v.safeParse(schema, params);
  return parsed.success ? network(type, parsed.output as Record<string, unknown>) : undefined;
}

/** The event of one CDP WebSocket or EventSource notification, or undefined for one capture does not record. */
export function streamDraft(
  method: string,
  params: unknown,
  sensitive: ReadonlySet<string>,
): Draft | undefined {
  switch (method) {
    case "Network.webSocketCreated":
      return simple("websocket-created", WebSocketCreatedSchema, params);
    case "Network.webSocketHandshakeResponseReceived":
      return handshake(params, sensitive);
    case "Network.webSocketFrameSent":
      return frame("sent", params);
    case "Network.webSocketFrameReceived":
      return frame("received", params);
    case "Network.webSocketFrameError":
      return simple("websocket-error", WebSocketErrorSchema, params);
    case "Network.webSocketClosed":
      return simple("websocket-closed", RequestIdSchema, params);
    case "Network.eventSourceMessageReceived":
      return eventSourceMessage(params);
    default:
      return undefined;
  }
}

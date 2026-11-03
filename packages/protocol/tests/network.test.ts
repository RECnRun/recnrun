import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  BodyRefSchema,
  CapturedEventSchema,
  EventSchema,
  isSha256,
  MAX_FRAME_PAYLOAD_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  REDACTED,
  SENSITIVE_HEADERS,
} from "../src/index.ts";

const envelope = {
  schemaVersion: 1,
  id: "cdp:S1#1",
  runId: "run-1",
  seq: 1,
  source: "S1",
  producer: "cdp:S1",
  timestamp: "2026-11-03T10:00:00.000Z",
  component: "application",
  targetId: "T1",
  frameId: "T1",
  documentId: null,
};

const network = (type: string, payload: Record<string, unknown>) => ({
  ...envelope,
  category: "network",
  type,
  payload,
});

const SHA = "a".repeat(64);
const ref = {
  sha256: SHA,
  mime: "application/json",
  encoding: "utf8",
  size: 10,
  condition: "captured",
};
const frame = {
  requestId: "W1",
  direction: "received",
  opcode: 1,
  encoding: "utf8",
  payload: "hello",
  size: 5,
  truncated: false,
};
const response = { requestId: "R", url: "u", status: 200, statusText: "", mimeType: "" };

const VALID: [string, ReturnType<typeof network>][] = [
  [
    "a request with redacted headers",
    network("request", {
      requestId: "R1",
      url: "u",
      method: "GET",
      headers: { Authorization: REDACTED, Accept: "*/*" },
    }),
  ],
  [
    "a response with headers, timing, and cache state",
    network("response", {
      ...response,
      headers: { "Set-Cookie": REDACTED },
      headersTruncated: true,
      timing: { requestTime: 12.5, dnsStart: -1, sendStart: 0.2, receiveHeadersEnd: 3.1 },
      cache: "disk",
      fromCache: true,
    }),
  ],
  [
    "a body stored as a blob",
    network("body", { requestId: "R1", url: "u", condition: "captured", blob: ref }),
  ],
  [
    "a truncated blob with its original size",
    network("body", {
      requestId: "R1",
      url: "u",
      condition: "truncated",
      blob: { ...ref, encoding: "binary", size: 2_000_000, condition: "truncated" },
    }),
  ],
  [
    "a WebSocket opening",
    network("websocket-created", { requestId: "W1", url: "ws://127.0.0.1:4600/ws/echo" }),
  ],
  [
    "a WebSocket handshake",
    network("websocket-handshake", {
      requestId: "W1",
      status: 101,
      statusText: "Switching Protocols",
      headers: { Upgrade: "websocket" },
    }),
  ],
  ["a text frame", network("websocket-frame", frame)],
  [
    "a truncated binary frame",
    network("websocket-frame", {
      ...frame,
      direction: "sent",
      opcode: 2,
      encoding: "base64",
      size: 9000,
      truncated: true,
    }),
  ],
  ["a WebSocket error", network("websocket-error", { requestId: "W1", errorMessage: "boom" })],
  ["a WebSocket close", network("websocket-closed", { requestId: "W1" })],
];

const body = (blob: Record<string, unknown>, condition = "captured") =>
  network("body", { requestId: "R", url: "u", condition, blob });

describe("network evidence", () => {
  test.each(VALID)("accepts %s, which is also a journal event", (_name, event) => {
    expect(v.parse(CapturedEventSchema, event)).toEqual(event);
    expect(v.is(EventSchema, event)).toBe(true);
  });

  test.each([
    ["an unknown cache state", network("response", { ...response, cache: "cdn" })],
    [
      "a header value past the cap",
      network("request", {
        requestId: "R",
        url: "u",
        method: "GET",
        headers: { A: "x".repeat(MAX_HEADER_VALUE_LENGTH + 1) },
      }),
    ],
    ["a blob whose hash is not sha256", body({ ...ref, sha256: "abc" })],
    ["a blob of an unread condition", body({ ...ref, condition: "unavailable" }, "unavailable")],
    [
      "a frame without its truncation flag",
      network("websocket-frame", { ...frame, truncated: undefined }),
    ],
    [
      "a frame of an unknown encoding",
      network("websocket-frame", { ...frame, encoding: "latin1" }),
    ],
    [
      "a frame past the inline cap",
      network("websocket-frame", { ...frame, payload: "x".repeat(MAX_FRAME_PAYLOAD_LENGTH + 1) }),
    ],
  ])("rejects %s", (_name, event) => {
    expect(v.is(CapturedEventSchema, event)).toBe(false);
  });

  test("a body reference names its blob by a lowercase sha256", () => {
    expect(v.is(BodyRefSchema, ref)).toBe(true);
    expect(isSha256(SHA)).toBe(true);
    expect(isSha256(SHA.toUpperCase())).toBe(false);
    expect(isSha256("../etc/passwd")).toBe(false);
  });

  test("the default sensitive headers are lowercase names", () => {
    expect(SENSITIVE_HEADERS).toEqual([
      "authorization",
      "cookie",
      "proxy-authorization",
      "set-cookie",
    ]);
  });
});

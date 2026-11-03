import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  CapturedEventSchema,
  DOM_EVENT_TYPES,
  EventSchema,
  HOOK_VERSION,
  MAX_CAPTURED_TEXT,
  MAX_INLINE_BODY_LENGTH,
  ObserverMessageSchema,
  parseJournalEvent,
} from "../src/index.ts";

const envelope = {
  schemaVersion: 1,
  id: "cdp:S1#1",
  runId: "run-1",
  seq: 1,
  source: "S1",
  producer: "cdp:S1",
  timestamp: "2026-11-02T10:00:00.000Z",
  component: "application",
  targetId: "T1",
  frameId: "T1",
  documentId: null,
};

const at = (category: string, type: string, payload: Record<string, unknown>) => ({
  ...envelope,
  category,
  type,
  payload,
});

const target = { tag: "input", testId: "name", name: "name" };

const VALID: [string, ReturnType<typeof at>][] = [
  ["a click", at("dom", "click", { target, isTrusted: true, x: 10, y: 20, button: 0, detail: 1 })],
  [
    "a keydown",
    at("dom", "keydown", { target, isTrusted: true, key: "A", code: "KeyA", modifiers: ["shift"] }),
  ],
  [
    "an input with a null data",
    at("dom", "input", { target, isTrusted: true, inputType: "deleteContentBackward", data: null }),
  ],
  ["a redacted keyup", at("dom", "keyup", { target, isTrusted: true, redacted: true })],
  ["a document scroll", at("dom", "scroll", { target: { tag: "#document" }, isTrusted: true })],
  ["a dialog", at("dom", "dialog-opening", { dialogType: "alert", message: "Hi", url: "x" })],
  ["a closed dialog", at("dom", "dialog-closed", { result: true })],
  [
    "a redirected request",
    at("network", "request", {
      requestId: "R1",
      url: "http://127.0.0.1:4600/routes/submit-result",
      method: "GET",
      resourceType: "Document",
      redirectChain: [{ url: "http://127.0.0.1:4600/api/submit", method: "POST", status: 303 }],
    }),
  ],
  [
    "a response",
    at("network", "response", {
      requestId: "R1",
      url: "u",
      status: 500,
      statusText: "Internal Server Error",
      mimeType: "application/json",
    }),
  ],
  ["a finished load", at("network", "finished", { requestId: "R1", encodedDataLength: 120 })],
  [
    "a failure",
    at("network", "failed", { requestId: "R1", errorText: "net::ERR_ABORTED", canceled: true }),
  ],
  [
    "a captured body",
    at("network", "body", { requestId: "R1", url: "u", condition: "captured", body: "{}" }),
  ],
  [
    "an unavailable body",
    at("network", "body", { requestId: "R1", url: "u", condition: "unavailable", reason: "gone" }),
  ],
  ["a console call", at("console", "api", { level: "error", args: ["boom"], line: 3 })],
  ["a log entry", at("console", "log", { source: "network", level: "error", text: "500" })],
  ["an exception", at("error", "exception", { text: "Uncaught", description: "Error: x" })],
  ["a navigation", at("navigation", "committed", { url: "u", parentFrameId: "F0" })],
  ["a same-document navigation", at("navigation", "same-document", { url: "u#b" })],
  ["an attach", at("target", "attached", { type: "page", url: "u", installMode: "late" })],
  ["a detach", at("target", "detached", {})],
  ["a hook install", at("target", "hook-installed", { url: "u", hookVersion: HOOK_VERSION })],
];

describe("CapturedEventSchema", () => {
  test.each(VALID)("accepts %s, which is also a journal event", (_name, event) => {
    expect(v.parse(CapturedEventSchema, event)).toEqual(event);
    expect(v.is(EventSchema, event)).toBe(true);
  });

  test.each([
    ["a DOM type the hook does not send", at("dom", "mousemove", { target, isTrusted: true })],
    ["a DOM event without a target", at("dom", "click", { isTrusted: true })],
    ["a fractional coordinate", at("dom", "click", { target, isTrusted: true, x: 1.5 })],
    ["an unknown modifier", at("dom", "click", { target, isTrusted: true, modifiers: ["fn"] })],
    [
      "a value past the clip length",
      at("dom", "input", { target, isTrusted: true, value: "x".repeat(MAX_CAPTURED_TEXT + 1) }),
    ],
    [
      "an unknown body condition",
      at("network", "body", { requestId: "R1", url: "u", condition: "partial" }),
    ],
    [
      "a body past the inline limit",
      at("network", "body", {
        requestId: "R1",
        url: "u",
        condition: "captured",
        body: "x".repeat(MAX_INLINE_BODY_LENGTH + 1),
      }),
    ],
    ["a network type in the wrong category", at("console", "request", {})],
    ["an extra payload field", at("target", "detached", { more: 1 })],
    ["an unknown category", at("cache", "set", {})],
  ])("rejects %s", (_name, event) => {
    expect(v.is(CapturedEventSchema, event)).toBe(false);
  });
});

test("a gap the hook reported is a captured event naming the producer it covers", () => {
  const payload = {
    reason: "buffer-exhausted",
    producer: `hook:${"a".repeat(32)}`,
    surface: "dom-events",
    fromSeq: 2,
    toSeq: 11,
    lost: 10,
  };
  const gap = { ...at("gap", "buffer-exhausted", payload), component: "collector" };
  expect(v.parse(CapturedEventSchema, gap)).toEqual(gap);
  const unknown = { ...gap, payload: { ...payload, reason: "other" } };
  expect(v.is(CapturedEventSchema, unknown)).toBe(false);
});

describe("DOM observer messages", () => {
  const message = {
    kind: "dom",
    type: "input",
    seq: 2,
    documentId: "0123456789abcdef0123456789abcdef",
    ts: 10,
    targetId: "T1",
    payload: { target, isTrusted: true, inputType: "insertText", data: "A", value: "A" },
  };

  test.each(DOM_EVENT_TYPES)("accepts a %s message", (type) => {
    expect(v.is(ObserverMessageSchema, { ...message, type })).toBe(true);
  });

  test.each([
    ["a lifecycle kind", { ...message, kind: "lifecycle" }],
    ["an unknown DOM type", { ...message, type: "wheel" }],
    ["an extra payload field", { ...message, payload: { ...message.payload, html: "<b>" } }],
  ])("rejects %s", (_name, value) => {
    expect(v.is(ObserverMessageSchema, value)).toBe(false);
  });
});

describe("parseJournalEvent", () => {
  test("returns the event when it is a journal event", () => {
    const [, event] = VALID[0] ?? [];
    expect(parseJournalEvent(event)).toEqual({ ok: true, event });
  });

  test("says what is wrong otherwise", () => {
    const parsed = parseJournalEvent({ ...envelope, category: "dom" });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toMatch(/type|payload/);
  });
});

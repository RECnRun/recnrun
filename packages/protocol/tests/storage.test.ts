import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  CapturedEventSchema,
  EventSchema,
  MAX_CAPTURED_TEXT,
  MAX_STORAGE_ITEMS,
  ObserverMessageSchema,
} from "../src/index.ts";

const envelope = {
  schemaVersion: 1,
  id: "cdp:S1#1",
  runId: "run-1",
  seq: 1,
  source: "S1",
  producer: "cdp:S1",
  timestamp: "2026-11-03T10:00:00.000Z",
  component: "browser",
  targetId: "T1",
  frameId: "T1",
  documentId: null,
};

const at = (type: string, payload: Record<string, unknown>) => ({
  ...envelope,
  category: "storage",
  type,
  payload,
});

const storageKey = "http://127.0.0.1:4600/";
const change = { observation: "observed-change", area: "local", storageKey };
const cookie = {
  name: "fixture-visible",
  domain: "127.0.0.1",
  path: "/",
  value: "v",
  httpOnly: false,
  secure: false,
  session: true,
};
const hidden = {
  ...cookie,
  name: "fixture-http-only",
  value: undefined,
  redacted: true,
  httpOnly: true,
  expires: 1_800_000_000,
  sameSite: "Strict",
};
const { value: _value, ...redacted } = hidden;

describe("storage events", () => {
  test.each([
    [
      "a snapshot of an area",
      at("snapshot", {
        observation: "snapshot",
        reason: "attach",
        area: "session",
        storageKey,
        items: [{ key: "k", value: "v" }],
      }),
    ],
    ["an added item", at("item-added", { ...change, key: "k", newValue: "v" })],
    [
      "an updated item, clipped",
      at("item-updated", { ...change, key: "k", oldValue: "a", newValue: "b", truncated: true }),
    ],
    ["a removed item", at("item-removed", { ...change, key: "k" })],
    ["a cleared area", at("items-cleared", change)],
    [
      "an operation that threw",
      at("operation", {
        observation: "observed-operation",
        area: "local",
        operation: "setItem",
        key: "k",
        value: "v",
        error: "QuotaExceededError",
      }),
    ],
    [
      "a cookie snapshot with a redacted cookie",
      at("cookies-snapshot", {
        observation: "snapshot",
        reason: "navigation",
        cookies: [cookie, redacted],
      }),
    ],
    ["an added cookie", at("cookie-added", { observation: "observed-change", cookie })],
    [
      "a removed cookie",
      at("cookie-removed", { observation: "observed-change", cookie: redacted }),
    ],
  ])("accepts %s, which is also a journal event", (_name, event) => {
    expect(v.parse(CapturedEventSchema, event)).toEqual(event);
    expect(v.is(EventSchema, event)).toBe(true);
  });

  const items = Array.from({ length: MAX_STORAGE_ITEMS + 1 }, () => ({ key: "k", value: "v" }));
  test.each([
    ["an unknown area", at("item-removed", { ...change, area: "indexeddb", key: "k" })],
    ["a change labeled a snapshot", at("item-removed", { ...change, observation: "snapshot" })],
    [
      "a value past the clip length",
      at("item-added", { ...change, key: "k", newValue: "x".repeat(MAX_CAPTURED_TEXT + 1) }),
    ],
    [
      "too many snapshot items",
      at("snapshot", {
        observation: "snapshot",
        reason: "attach",
        area: "local",
        storageKey,
        items,
      }),
    ],
    [
      "an operation the hook does not wrap",
      at("operation", { observation: "observed-operation", area: "local", operation: "getItem" }),
    ],
    [
      "an unknown cookie field",
      at("cookie-added", { observation: "observed-change", cookie: { ...cookie, extra: 1 } }),
    ],
    ["an unknown storage type", at("cookie-read", { observation: "observed-change", cookie })],
  ])("rejects %s", (_name, event) => {
    expect(v.is(CapturedEventSchema, event)).toBe(false);
  });
});

describe("storage observer messages", () => {
  const message = {
    kind: "storage",
    type: "storage.operation",
    seq: 3,
    documentId: "0123456789abcdef0123456789abcdef",
    ts: 12,
    targetId: "T1",
    payload: { area: "session", operation: "removeItem", key: "k" },
  };

  test("a hooked storage call parses", () => {
    expect(v.parse(ObserverMessageSchema, message)).toEqual(message);
  });

  test("a storage message with an extra payload field is rejected", () => {
    const payload = { ...message.payload, stack: "x" };
    expect(v.is(ObserverMessageSchema, { ...message, payload })).toBe(false);
  });
});

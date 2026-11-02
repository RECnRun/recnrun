import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { EventSchema } from "../src/index.ts";

const envelope = {
  schemaVersion: 1,
  id: "evt-456",
  runId: "run-123",
  seq: 42,
  source: "profile-A/page-2",
  producer: "adapter.network",
  timestamp: "2026-11-01T10:00:00.000Z",
  targetId: "target-1",
  frameId: "frame-1",
  documentId: "doc-3",
};

describe("EventSchema", () => {
  test("accepts the §11 envelope of an observed event", () => {
    const event = {
      ...envelope,
      monotonicTimeMs: 1842.5,
      receivedAt: "2026-11-01T10:00:00.015Z",
      actor: "human",
      component: "application",
      profileBinding: "solicitante",
      stepId: "criar",
      commandId: null,
      category: "network",
      type: "request",
      causalConfidence: "temporal-only",
      payload: { url: "https://example.test/pedidos" },
      payloadRef: "blobs/sha256/abc",
    };
    expect(v.parse(EventSchema, event)).toEqual(event);
  });

  test("accepts an event outside any page", () => {
    const event = {
      ...envelope,
      targetId: null,
      frameId: null,
      documentId: null,
      category: "connection",
      type: "lost",
      payload: {},
    };
    expect(v.safeParse(EventSchema, event).success).toBe(true);
  });

  test("accepts a gap that accounts for lost sequences", () => {
    const gap = {
      ...envelope,
      category: "gap",
      type: "gap",
      payload: {
        reason: "buffer-exhausted",
        surface: "network",
        fromSeq: 10,
        toSeq: 999,
        lost: 990,
      },
    };
    expect(v.safeParse(EventSchema, gap).success).toBe(true);
  });

  test.each([
    ["a gap without a reason", { category: "gap", type: "gap", payload: {} }],
    ["an unknown category", { category: "telemetry", type: "x", payload: {} }],
    ["a negative sequence", { seq: -1, category: "dom", type: "click", payload: {} }],
    ["a timestamp that is not ISO", { timestamp: "yesterday", category: "dom", type: "click" }],
    ["an unknown causal confidence", { category: "dom", type: "click", causalConfidence: "sure" }],
    ["a missing frame id", { frameId: undefined, category: "dom", type: "click", payload: {} }],
  ])("rejects %s", (_name, override) => {
    expect(v.safeParse(EventSchema, { ...envelope, payload: {}, ...override }).success).toBe(false);
  });
});

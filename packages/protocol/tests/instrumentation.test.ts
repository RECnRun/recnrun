import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_OBSERVER_BUFFER,
  HOOK_VERSION,
  INSTALL_MODES,
  InstrumentationEventSchema,
  InstrumentationReportSchema,
  ObserverMessageSchema,
} from "../src/index.ts";

const DOC = "0123456789abcdef0123456789abcdef";

const installed = {
  kind: "lifecycle",
  type: "document.hook-installed",
  seq: 1,
  documentId: DOC,
  ts: 4.2,
  targetId: "T1",
  payload: { url: "http://127.0.0.1:4600/", hookVersion: HOOK_VERSION },
};

test("accepts the hook's install message", () => {
  expect(v.parse(ObserverMessageSchema, installed)).toEqual(installed);
});

test.each([
  ["an unknown type", { ...installed, type: "document.unknown" }],
  ["a sequence below one", { ...installed, seq: 0 }],
  ["a document id that is not 32 hex digits", { ...installed, documentId: "ABC" }],
  ["a negative time", { ...installed, ts: -1 }],
  ["an empty target id", { ...installed, targetId: "" }],
  ["another hook version", { ...installed, payload: { url: "x", hookVersion: HOOK_VERSION + 1 } }],
  ["an extra field", { ...installed, extra: true }],
  ["an extra payload field", { ...installed, payload: { ...installed.payload, more: 1 } }],
])("rejects %s", (_name, message) => {
  expect(v.is(ObserverMessageSchema, message)).toBe(false);
});

test("an event carries its source sequence, target, frame, and document", () => {
  const event = {
    type: "document.hook-installed",
    source: "S1",
    seq: 1,
    at: "2026-11-02T10:00:00.000Z",
    targetId: "T1",
    sessionId: "S1",
    frameId: null,
    documentId: DOC,
    installMode: "before-first-script",
    hookSeq: 1,
    monotonicTimeMs: 4.2,
    url: "http://127.0.0.1:4600/",
  };
  expect(v.is(InstrumentationEventSchema, event)).toBe(true);
  expect(v.is(InstrumentationEventSchema, { ...event, installMode: "ignored" })).toBe(false);
  expect(v.is(InstrumentationEventSchema, { ...event, frameId: "" })).toBe(false);
});

test("a report lists targets with their install mode and counters", () => {
  const report = {
    targets: INSTALL_MODES.map((installMode, index) => ({
      targetId: `T${index}`,
      sessionId: `S${index}`,
      type: "page",
      url: "about:blank",
      installMode,
      hookInstalled: false,
      hookInstalls: 0,
      droppedInvalid: 0,
      droppedUnknownFrame: 0,
      detached: false,
    })),
    dedicatedWorkers: { observed: true },
    serviceWorkers: { observed: false },
  };
  expect(v.is(InstrumentationReportSchema, report)).toBe(true);
  const broken = { ...report, targets: [{ ...report.targets[0], droppedInvalid: -1 }] };
  expect(v.is(InstrumentationReportSchema, broken)).toBe(false);
});

describe("the hook's buffer-exhausted message", () => {
  const exhausted = {
    kind: "gap",
    type: "buffer.exhausted",
    seq: 12,
    documentId: DOC,
    ts: 9,
    targetId: "T1",
    payload: { fromSeq: 2, toSeq: 11, lost: 10, kinds: ["dom"] },
  };

  test("names the sequence range it dropped and the kinds of message in it", () => {
    expect(v.parse(ObserverMessageSchema, exhausted)).toEqual(exhausted);
    expect(DEFAULT_OBSERVER_BUFFER).toBeGreaterThanOrEqual(1000);
  });

  test.each([
    ["an empty range", { fromSeq: 0, toSeq: 0, lost: 0, kinds: [] }],
    ["an unknown kind", { fromSeq: 2, toSeq: 2, lost: 1, kinds: ["network"] }],
    ["a missing count", { fromSeq: 2, toSeq: 3, kinds: ["dom"] }],
  ])("rejects %s", (_name, payload) => {
    expect(v.is(ObserverMessageSchema, { ...exhausted, payload })).toBe(false);
  });
});

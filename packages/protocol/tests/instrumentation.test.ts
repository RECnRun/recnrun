import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
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

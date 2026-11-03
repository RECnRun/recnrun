import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  coverageOf,
  RunCoverageSchema,
  surfaceOf,
  tallyCoverage,
  type Event,
  type GapPayload,
} from "../src/index.ts";

let seq = 0;

const line = (category: string, type: string, payload: Record<string, unknown> = {}): Event =>
  ({
    schemaVersion: 1,
    id: `p#${(seq += 1)}`,
    runId: "run-1",
    seq,
    source: "S1",
    producer: "p",
    timestamp: "2026-11-03T10:00:00.000Z",
    targetId: null,
    frameId: null,
    documentId: null,
    category,
    type,
    payload,
  }) as Event;

const gap = (payload: GapPayload) => line("gap", payload.reason, payload);

test.each([
  ["dom", "click", "dom-events"],
  ["navigation", "committed", "navigation"],
  ["target", "attached", "navigation"],
  ["network", "response", "network"],
  ["network", "websocket-frame", "websocket-sse"],
  ["network", "eventsource-message", "websocket-sse"],
  ["console", "api", "console-errors"],
  ["error", "exception", "console-errors"],
  ["storage", "operation", "web-storage"],
  ["storage", "cookies-snapshot", "cookies"],
  ["snapshot", "captured", "dom-screen"],
  ["step", "step.started", undefined],
])("a %s %s event belongs to %s", (category, type, surface) => {
  expect(surfaceOf(line(category, type))).toBe(surface);
});

test("a gap belongs to the surface it names, or to none", () => {
  expect(surfaceOf(gap({ reason: "buffer-exhausted", surface: "dom-events" }))).toBe("dom-events");
  expect(surfaceOf(gap({ reason: "connection-lost" }))).toBeUndefined();
});

test("coverage counts events per surface and gaps per reason, so it reconciles with the journal", () => {
  const journal = [
    line("step", "step.started"),
    line("dom", "click"),
    line("dom", "input"),
    gap({ reason: "buffer-exhausted", surface: "dom-events", fromSeq: 3, toSeq: 12, lost: 10 }),
    gap({ reason: "buffer-exhausted", surface: "dom-events", fromSeq: 20, toSeq: 21 }),
    line("snapshot", "captured"),
    gap({ reason: "connection-lost", startedAt: "2026-11-03T10:00:01.000Z" }),
  ];
  const coverage = coverageOf("run-1", journal);
  expect(v.parse(RunCoverageSchema, coverage)).toEqual(coverage);
  expect(coverage).toEqual({
    schemaVersion: 1,
    runId: "run-1",
    events: 4,
    gaps: [
      { reason: "buffer-exhausted", gaps: 2, lostEvents: 12 },
      { reason: "connection-lost", gaps: 1, lostEvents: 0 },
    ],
    surfaces: [
      {
        surface: "dom-events",
        status: "partial",
        reasons: ["buffer-exhausted", "connection-lost"],
        events: 2,
        gaps: 2,
        lostEvents: 12,
      },
      {
        surface: "dom-screen",
        status: "partial",
        reasons: ["connection-lost"],
        events: 1,
        gaps: 0,
        lostEvents: 0,
      },
    ],
  });
});

test("a run without gaps covers each surface it saw in full", () => {
  const coverage = coverageOf("run-2", [line("network", "request"), line("step", "step.finished")]);
  expect(coverage).toEqual({
    schemaVersion: 1,
    runId: "run-2",
    events: 2,
    gaps: [],
    surfaces: [
      { surface: "network", status: "implemented", reasons: [], events: 1, gaps: 0, lostEvents: 0 },
    ],
  });
});

test("an incremental tally gives the same coverage as the whole journal", () => {
  const journal = [line("dom", "click"), gap({ reason: "capture-suspended" })];
  const tally = tallyCoverage();
  for (const event of journal) tally.add(event);
  expect(tally.coverage("run-3")).toEqual(coverageOf("run-3", journal));
});

test("coverage files written before the counts existed still parse", () => {
  const old = { schemaVersion: 1, runId: "run-0", surfaces: [] };
  expect(v.safeParse(RunCoverageSchema, old).success).toBe(true);
});

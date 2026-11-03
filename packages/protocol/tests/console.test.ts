import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  CapturedEventSchema,
  EventSchema,
  MAX_CONSOLE_ARGS,
  MAX_STACK_FRAMES,
  MAX_VALUE_PROPERTIES,
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

const at = (category: string, type: string, payload: Record<string, unknown>) => ({
  ...envelope,
  category,
  type,
  payload,
});

const frame = { functionName: "inner", url: "http://127.0.0.1:4600/c.js", line: 3, column: 7 };
const nested = { type: "object", description: "Object", properties: [], truncated: true };
const object = {
  type: "object",
  className: "Object",
  description: "Object",
  preview: {
    type: "object",
    description: "Object",
    properties: [
      { name: "count", type: "number", value: "2" },
      { name: "child", type: "object", value: "Object", preview: nested },
    ],
    entries: [{ key: nested, value: nested }],
    truncated: true,
  },
};

describe("console and error events", () => {
  test.each([
    [
      "a call with values and a stack",
      at("console", "api", {
        level: "log",
        args: ["note", "Object"],
        values: [{ type: "string", value: "note" }, object],
        stack: { frames: [frame, { ...frame, functionName: "" }] },
        truncated: true,
        line: 3,
      }),
    ],
    [
      "a primitive past the clip length",
      at("console", "api", {
        level: "log",
        args: [],
        values: [{ type: "string", value: "x", truncated: true }],
      }),
    ],
    [
      "a log entry with a stack",
      at("console", "log", {
        source: "javascript",
        level: "warning",
        text: "t",
        stack: { frames: [frame] },
      }),
    ],
    [
      "an exception with a cut stack",
      at("error", "exception", {
        text: "Uncaught",
        description: "Error: x",
        stack: { frames: [frame], truncated: true },
        truncated: true,
      }),
    ],
  ])("accepts %s, which is also a journal event", (_name, event) => {
    expect(v.parse(CapturedEventSchema, event)).toEqual(event);
    expect(v.is(EventSchema, event)).toBe(true);
  });

  const deeper = { ...nested, properties: [{ name: "a", type: "object", preview: nested }] };
  const many = Array.from({ length: MAX_VALUE_PROPERTIES + 1 }, (_, i) => ({
    name: String(i),
    type: "number",
    value: String(i),
  }));
  const withPreview = (preview: unknown) => ({ type: "object", preview });

  test.each([
    ["too many arguments", { level: "log", args: Array(MAX_CONSOLE_ARGS + 1).fill("a") }],
    [
      "a preview three levels deep",
      {
        level: "log",
        args: [],
        values: [
          withPreview({
            ...object.preview,
            properties: [{ name: "c", type: "object", preview: deeper }],
          }),
        ],
      },
    ],
    [
      "too many properties",
      { level: "log", args: [], values: [withPreview({ type: "object", properties: many })] },
    ],
    [
      "too many stack frames",
      { level: "log", args: [], stack: { frames: Array(MAX_STACK_FRAMES + 1).fill(frame) } },
    ],
    ["a zero-based frame", { level: "log", args: [], stack: { frames: [{ ...frame, line: -1 }] } }],
    ["a truncated flag set to false", { level: "log", args: [], truncated: false }],
  ])("rejects %s", (_name, payload) => {
    expect(v.is(CapturedEventSchema, at("console", "api", payload))).toBe(false);
  });
});

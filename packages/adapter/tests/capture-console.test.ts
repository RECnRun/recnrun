import {
  MAX_CAPTURED_TEXT,
  MAX_CONSOLE_ARGS,
  MAX_STACK_FRAMES,
  MAX_VALUE_PROPERTIES,
} from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { capturing } from "./capture-harness.ts";

const callFrames = Array.from({ length: MAX_STACK_FRAMES + 8 }, (_, index) => ({
  functionName: index === 0 ? "inner" : "",
  scriptId: "9",
  url: "http://x/console.js",
  lineNumber: index,
  columnNumber: 4,
}));

const property = (name: string, valuePreview?: unknown) => ({
  name,
  type: "object",
  value: "Object",
  ...(valuePreview !== undefined && { valuePreview }),
});

const leaf = { type: "object", description: "Object", overflow: false, properties: [] };
// A console.table preview nests two levels; the journal keeps one level under the argument.
const tableRow = { ...leaf, properties: [property("deep", leaf)] };

const objectArg = {
  type: "object",
  className: "Object",
  description: "Object",
  objectId: "1.2.3",
  preview: {
    type: "object",
    description: "Object",
    overflow: false,
    properties: [
      property("row", tableRow),
      ...Array.from({ length: MAX_VALUE_PROPERTIES + 4 }, (_, index) => ({
        name: `p${index}`,
        type: "number",
        value: String(index),
      })),
    ],
  },
};

const mapArg = {
  type: "object",
  subtype: "map",
  className: "Map",
  description: "Map(1)",
  preview: {
    type: "object",
    subtype: "map",
    description: "Map(1)",
    overflow: true,
    properties: [],
    entries: [
      {
        key: { type: "string", description: "k", overflow: false, properties: [] },
        value: leaf,
      },
    ],
  },
};

const longText = "x".repeat(MAX_CAPTURED_TEXT * 5);

test("console values keep a bounded preview and flag what the limits cut", async () => {
  const { channel, of } = await capturing();
  channel.attach("S1", { targetId: "T1", type: "page" });
  const filler = Array.from({ length: MAX_CONSOLE_ARGS + 4 }, () => ({ type: "number", value: 1 }));
  channel.emit(
    "Runtime.consoleAPICalled",
    {
      type: "log",
      executionContextId: 1,
      stackTrace: { callFrames },
      args: [
        { type: "string", value: longText },
        objectArg,
        mapArg,
        { type: "bigint", unserializableValue: "12n", description: "12n" },
        ...filler,
      ],
    },
    "S1",
  );
  const [call] = of("console", "api");
  expect(call?.payload).toMatchObject({
    truncated: true,
    url: "http://x/console.js",
    line: 1,
    column: 5,
  });
  const payload = call?.payload as Record<string, unknown[]>;
  expect(payload.args).toHaveLength(MAX_CONSOLE_ARGS);
  expect(payload.values).toHaveLength(MAX_CONSOLE_ARGS);
  const [text, object, map, big] = payload.values ?? [];
  expect(text).toEqual({
    type: "string",
    value: longText.slice(0, MAX_CAPTURED_TEXT),
    truncated: true,
  });
  expect(big).toEqual({ type: "bigint", unserializableValue: "12n", description: "12n" });
  expect(object).toMatchObject({
    type: "object",
    className: "Object",
    preview: { truncated: true },
  });
  const preview = (object as { preview: { properties: unknown[] } }).preview;
  expect(preview.properties).toHaveLength(MAX_VALUE_PROPERTIES);
  expect(preview.properties[0]).toEqual({
    name: "row",
    type: "object",
    value: "Object",
    preview: {
      type: "object",
      description: "Object",
      properties: [{ name: "deep", type: "object", value: "Object" }],
      truncated: true,
    },
  });
  expect(map).toMatchObject({
    subtype: "map",
    preview: {
      truncated: true,
      entries: [
        { key: { type: "string", description: "k", properties: [] }, value: { properties: [] } },
      ],
    },
  });
  expect(call?.payload).toMatchObject({
    stack: {
      truncated: true,
      frames: expect.arrayContaining([
        { functionName: "inner", url: "http://x/console.js", line: 1, column: 5 },
      ]),
    },
  });
  expect(payload.stack).toHaveProperty("frames.length", MAX_STACK_FRAMES);
});

test("exceptions and log entries keep their stack, and a long description is clipped", async () => {
  const { channel, of } = await capturing();
  channel.attach("S1", { targetId: "T1", type: "page" });
  const stackTrace = { callFrames: callFrames.slice(0, 2) };
  channel.emit(
    "Runtime.exceptionThrown",
    {
      exceptionDetails: {
        text: "Uncaught",
        lineNumber: 0,
        columnNumber: 4,
        stackTrace,
        exception: { type: "object", subtype: "error", description: longText },
      },
    },
    "S1",
  );
  channel.emit(
    "Log.entryAdded",
    { entry: { source: "javascript", level: "warning", text: "t", stackTrace } },
    "S1",
  );
  const frames = [
    { functionName: "inner", url: "http://x/console.js", line: 1, column: 5 },
    { functionName: "", url: "http://x/console.js", line: 2, column: 5 },
  ];
  expect(of("error", "exception")[0]?.payload).toEqual({
    text: "Uncaught",
    description: longText.slice(0, MAX_CAPTURED_TEXT),
    truncated: true,
    stack: { frames },
    line: 1,
    column: 5,
  });
  expect(of("console", "log")[0]?.payload).toMatchObject({ stack: { frames } });
});

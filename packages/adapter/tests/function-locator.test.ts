import { expect, test } from "vite-plus/test";
import { applyCardinality } from "../src/function-locator-cardinality.ts";
import { resolveFunctionLocator } from "../src/index.ts";
import { object, page, request, released, ScriptedChannel } from "./function-locator-page.ts";

test.each([
  ["one", [], undefined, ["not-found", []]],
  ["one", ["a"], undefined, ["matched", ["a"]]],
  ["one", ["a", "b"], undefined, ["ambiguous", []]],
  ["optional", [], undefined, ["matched", []]],
  ["optional", ["a"], undefined, ["matched", ["a"]]],
  ["optional", ["a", "b"], undefined, ["ambiguous", []]],
  ["many", [], undefined, ["not-found", []]],
  ["many", ["a", "b"], undefined, ["matched", ["a", "b"]]],
  ["nth", ["a", "b", "c"], 1, ["matched", ["b"]]],
  ["nth", ["a", "b"], 2, ["not-found", []]],
] as const)("%s over %j (index %s) is %j", (cardinality, items, index, [status, selected]) => {
  expect(applyCardinality([...items], cardinality, index)).toEqual({
    status,
    selected: [...selected],
  });
});

test("runs the function in an isolated world of the main frame and qualifies the element", async () => {
  const { channel, target } = page(object("el-1", "node"), ["el-1"], { "el-1": 42 });
  const result = await resolveFunctionLocator(target, request({ args: { id: "x" } }));
  expect(result).toMatchObject({
    status: "matched",
    cardinality: "one",
    count: 1,
    elements: [
      { targetId: "T1", frameId: "F1", loaderId: "L1", objectId: "el-1", backendNodeId: 42 },
    ],
  });
  expect(result.objectGroup).toMatch(/^recnrun-locator-/);
  expect(channel.sentOf("Page.createIsolatedWorld")[0]?.params).toMatchObject({
    frameId: "F1",
    worldName: "__recnrun_locator",
  });
  expect(channel.sentOf("Runtime.callFunctionOn")[0]?.params).toMatchObject({
    executionContextId: 7,
    returnByValue: false,
    awaitPromise: true,
    objectGroup: result.objectGroup,
    arguments: [{ objectId: "scope" }, { value: { id: "x" } }],
  });
  expect(channel.sent.every((each) => each.sessionId === "S1")).toBe(true);
});

test("a matched result releases every other handle now and its group on release()", async () => {
  const { channel, target } = page(object("raw"), ["a", "b", "c"], { a: 1, b: 2, c: 3 });
  const result = await resolveFunctionLocator(target, request({ cardinality: "nth", index: 1 }));
  expect(result.elements.map(({ objectId }) => objectId)).toEqual(["b"]);
  expect(released(channel).toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual([
    "a",
    "c",
    "list",
    "raw",
    "scope",
  ]);
  expect(channel.sentOf("Runtime.releaseObjectGroup")).toEqual([]);
  await result.release();
  expect(channel.sentOf("Runtime.releaseObjectGroup")[0]?.params).toEqual({
    objectGroup: result.objectGroup,
  });
});

test("the same element returned twice counts once", async () => {
  const { channel, target } = page(object("raw", "array"), ["a", "a2", "b"], { a: 1, a2: 1, b: 2 });
  const result = await resolveFunctionLocator(target, request({ cardinality: "many" }));
  expect(result).toMatchObject({ status: "matched", count: 2 });
  expect(result.elements.map(({ backendNodeId }) => backendNodeId)).toEqual([1, 2]);
  expect(released(channel)).toContain("a2");
});

test.each([
  ["ambiguous", object("raw", "array"), ["a", "b"]],
  ["not-found", { result: { type: "object", subtype: "null" } }, []],
] as const)(
  "a %s result keeps no reference and releases its group",
  async (status, value, items) => {
    const { channel, target } = page(value, [...items], { a: 1, b: 2 });
    const result = await resolveFunctionLocator(target, request());
    expect(result).toMatchObject({ status, count: items.length, elements: [] });
    expect(channel.sentOf("Runtime.releaseObjectGroup")[0]?.params).toEqual({
      objectGroup: result.objectGroup,
    });
  },
);

test("undefined counts as no element", async () => {
  const { target } = page({ result: { type: "undefined" } });
  const result = await resolveFunctionLocator(target, request({ cardinality: "optional" }));
  expect(result).toMatchObject({ status: "matched", count: 0, elements: [] });
});

test("a throwing function is an error with the exception's first line", async () => {
  const thrown = {
    result: { type: "object", subtype: "error" },
    exceptionDetails: {
      text: "Uncaught",
      exception: { type: "object", description: "Error: boom\n    at <anonymous>:1:7" },
    },
  };
  const { target } = page(thrown);
  const result = await resolveFunctionLocator(target, request());
  expect(result).toMatchObject({ status: "error", error: { message: "Error: boom" } });
});

test("a thrown string is reported as the string", async () => {
  const thrown = {
    result: { type: "string" },
    exceptionDetails: { text: "Uncaught", exception: { type: "string", value: "nope" } },
  };
  const { target } = page(thrown);
  expect((await resolveFunctionLocator(target, request())).error).toEqual({ message: "nope" });
});

test("a string is unsupported", async () => {
  const { target } = page({ result: { type: "string", value: "li" } });
  const result = await resolveFunctionLocator(target, request());
  expect(result).toMatchObject({
    status: "unsupported",
    error: { message: "The locator function returned a string, not elements." },
  });
});

test("an object that is not elements is unsupported with the page's reason", async () => {
  const { channel, target } = page(object("raw"));
  channel.replies.set("Runtime.callFunctionOn", (params) =>
    params?.objectId === undefined
      ? object("raw")
      : {
          result: { type: "object" },
          exceptionDetails: {
            text: "Uncaught",
            exception: { type: "object", description: "TypeError: Item 0 is not an element" },
          },
        },
  );
  const result = await resolveFunctionLocator(target, request());
  expect(result).toMatchObject({
    status: "unsupported",
    error: { message: "TypeError: Item 0 is not an element" },
  });
});

test("a named frame runs the function there, and an unknown frame is an error", async () => {
  const { channel, target } = page(object("el", "node"), ["el"]);
  const inChild = await resolveFunctionLocator(target, request({ frameId: "F2" }));
  expect(inChild.elements[0]).toMatchObject({ frameId: "F2", loaderId: "L2" });
  expect(channel.sentOf("Page.createIsolatedWorld")[0]?.params).toMatchObject({ frameId: "F2" });
  const missing = await resolveFunctionLocator(target, request({ frameId: "F9" }));
  expect(missing).toMatchObject({
    status: "error",
    error: { message: "The target has no frame F9." },
  });
});

test("an endpoint attaches a flat session, and closes it once nothing is held", async () => {
  const { channel } = page(object("el", "node"), ["el"]);
  channel.replies.set("Target.attachToTarget", () => ({ sessionId: "S9" }));
  const openChannel = () => Promise.resolve(channel);
  const target = { endpoint: "ws://127.0.0.1:9222/devtools/browser/x", targetId: "T1" };
  const result = await resolveFunctionLocator(target, request(), { openChannel });
  expect(channel.sentOf("Target.attachToTarget")[0]?.params).toEqual({
    targetId: "T1",
    flatten: true,
  });
  expect(channel.sentOf("Page.getFrameTree")[0]?.sessionId).toBe("S9");
  expect(channel.closed).toBe(false);
  await result.release();
  expect(channel.closed).toBe(true);

  const none = page({ result: { type: "object", subtype: "null" } });
  none.channel.replies.set("Target.attachToTarget", () => ({ sessionId: "S9" }));
  const empty = await resolveFunctionLocator(target, request(), {
    openChannel: () => Promise.resolve(none.channel),
  });
  expect(empty.status).toBe("not-found");
  expect(none.channel.closed).toBe(true);
});

test("an endpoint whose target cannot be attached closes the socket and throws", async () => {
  const channel = new ScriptedChannel();
  channel.failing.set("Target.attachToTarget", "No target with given id found");
  const target = { endpoint: "ws://127.0.0.1:9222/devtools/browser/x", targetId: "T0" };
  await expect(
    resolveFunctionLocator(target, request(), { openChannel: () => Promise.resolve(channel) }),
  ).rejects.toThrow("No target with given id found");
  expect(channel.closed).toBe(true);
});

test("an invalid request is refused before anything is sent", () => {
  const { channel, target } = page(object("el", "node"));
  expect(() => resolveFunctionLocator(target, request({ cardinality: "nth" }))).toThrow(
    "cardinality: nth needs an index.",
  );
  expect(channel.sent).toEqual([]);
});

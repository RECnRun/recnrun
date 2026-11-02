import type { FunctionLocatorRequest } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import type { CdpSession } from "../src/cdp-link.ts";
import { applyCardinality } from "../src/function-locator-cardinality.ts";
import { resolveFunctionLocator } from "../src/index.ts";
import { FakeChannel } from "./fake-channel.ts";

type Params = Record<string, unknown> | undefined;
type Responder = (params: Params) => unknown;

const NEVER = new Promise<never>(() => undefined);

/** The fake channel with scripted replies per method; an unscripted method answers `{}`. */
class ScriptedChannel extends FakeChannel {
  readonly replies = new Map<string, Responder>();

  override send(method: string, params?: Params, sessionId?: string): Promise<unknown> {
    const sent = super.send(method, params, sessionId);
    if (this.failing.has(method)) return sent;
    const reply = this.replies.get(method)?.(params) ?? {};
    return reply instanceof Promise ? reply : Promise.resolve(reply);
  }

  sentOf(method: string) {
    return this.sent.filter((each) => each.method === method);
  }
}

const object = (objectId: string, subtype?: string) => ({
  result: { type: "object", objectId, ...(subtype && { subtype }) },
});

/** A page whose locator returns `value`, whose list holds `items`, and whose nodes map by handle. */
function page(value: unknown, items: string[] = [], nodes: Record<string, number> = {}) {
  const channel = new ScriptedChannel();
  channel.replies.set("Page.getFrameTree", () => ({
    frameTree: {
      frame: { id: "F1", loaderId: "L1" },
      childFrames: [{ frame: { id: "F2", loaderId: "L2" } }],
    },
  }));
  channel.replies.set("Page.createIsolatedWorld", () => ({ executionContextId: 7 }));
  channel.replies.set("Runtime.evaluate", (params) =>
    params?.expression === "1+1" ? { result: { type: "number", value: 2 } } : object("scope"),
  );
  channel.replies.set("Runtime.callFunctionOn", (params) =>
    params?.objectId === undefined ? value : object("list", "array"),
  );
  channel.replies.set("Runtime.getProperties", () => ({
    result: [
      ...items.map((objectId, index) => ({
        name: String(index),
        value: { type: "object", objectId },
      })),
      { name: "length", value: { type: "number", value: items.length } },
    ],
  }));
  channel.replies.set("DOM.describeNode", (params) => ({
    node: { backendNodeId: nodes[String(params?.objectId)] ?? 1 },
  }));
  const session: CdpSession = { send: (method, params) => channel.send(method, params, "S1") };
  return { channel, target: { session, targetId: "T1" } };
}

const request = (overrides: Partial<FunctionLocatorRequest> = {}): FunctionLocatorRequest => ({
  source: "({ root }) => root.querySelectorAll('li')",
  cardinality: "one",
  timeoutMs: 1_000,
  ...overrides,
});

const released = (channel: ScriptedChannel) =>
  channel.sentOf("Runtime.releaseObject").map(({ params }) => params?.objectId);

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

test("a blocked renderer is terminated on the same session and probed again", async () => {
  const { channel, target } = page(NEVER);
  let probes = 0;
  channel.replies.set("Runtime.evaluate", (params) => {
    if (params?.expression !== "1+1") return object("scope");
    probes += 1;
    return probes === 1 ? NEVER : { result: { type: "number", value: 2 } };
  });
  const result = await resolveFunctionLocator(target, request({ timeoutMs: 20 }), {
    probeTimeoutMs: 20,
  });
  expect(result).toMatchObject({
    status: "error",
    error: { message: "The locator function did not finish within 20 ms." },
    deadline: { timeoutMs: 20, blocked: true, terminated: true, tabResponsive: true },
  });
  expect(channel.sentOf("Runtime.terminateExecution")).toEqual([
    { method: "Runtime.terminateExecution", sessionId: "S1" },
  ]);
});

test("a renderer that still answers is not terminated, and one that never does is unresponsive", async () => {
  const awaiting = page(NEVER);
  const pending = await resolveFunctionLocator(awaiting.target, request({ timeoutMs: 10 }));
  expect(pending.deadline).toEqual({
    timeoutMs: 10,
    blocked: false,
    terminated: false,
    tabResponsive: true,
  });
  expect(awaiting.channel.sentOf("Runtime.terminateExecution")).toEqual([]);

  const stuck = page(NEVER);
  stuck.channel.replies.set("Runtime.evaluate", (params) =>
    params?.expression === "1+1" ? NEVER : object("scope"),
  );
  stuck.channel.replies.set("Runtime.terminateExecution", () => NEVER);
  const hung = await resolveFunctionLocator(stuck.target, request({ timeoutMs: 10 }), {
    probeTimeoutMs: 10,
  });
  expect(hung.deadline).toEqual({
    timeoutMs: 10,
    blocked: true,
    terminated: false,
    tabResponsive: false,
  });
});

test("releasing handles of a renderer that never answers does not hang", async () => {
  const stuck = page(object("el", "node"), ["el"]);
  stuck.channel.replies.set("Runtime.releaseObject", () => NEVER);
  stuck.channel.replies.set("Runtime.releaseObjectGroup", () => NEVER);
  const options = { probeTimeoutMs: 10 };
  const matched = await resolveFunctionLocator(stuck.target, request(), options);
  await matched.release();
  const none = page({ result: { type: "object", subtype: "null" } });
  none.channel.replies.set("Runtime.releaseObjectGroup", () => NEVER);
  expect((await resolveFunctionLocator(none.target, request(), options)).status).toBe("not-found");
}, 2_000);

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

import {
  HOOK_VERSION,
  InstrumentationEventSchema,
  InstrumentationReportSchema,
  MAX_OBSERVER_MESSAGE_LENGTH,
  OBSERVER_BINDING,
  type InstrumentationEvent,
} from "@recnrun/protocol";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  instrument,
  instrumentChannel,
  type Instrumentation,
  type InstrumentOptions,
} from "../src/index.ts";
import { FakeChannel } from "./fake-channel.ts";
import { NOW, now } from "./fake-cdp.ts";

const DOC = "0123456789abcdef0123456789abcdef";
const PAGE_ORDER = [
  "Target.setAutoAttach",
  "Page.enable",
  "Page.addScriptToEvaluateOnNewDocument",
  "Runtime.enable",
  "Runtime.addBinding",
];

async function start(options: InstrumentOptions = {}) {
  const channel = new FakeChannel();
  const events: InstrumentationEvent[] = [];
  const handle = await instrumentChannel(channel, {
    now,
    onEvent: (e) => events.push(e),
    ...options,
  });
  return { channel, events, handle };
}

const message = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "lifecycle",
    type: "document.hook-installed",
    seq: 1,
    documentId: DOC,
    ts: 12.5,
    targetId: "T1",
    payload: { url: "http://127.0.0.1:4600/routes/form", hookVersion: HOOK_VERSION },
    ...overrides,
  });

function context(channel: FakeChannel, sessionId: string, id: number, frameId?: string) {
  channel.emit(
    "Runtime.executionContextCreated",
    { context: { id, ...(frameId && { auxData: { frameId } }) } },
    sessionId,
  );
}

function call(channel: FakeChannel, sessionId: string, contextId: number, payload: string) {
  channel.emit(
    "Runtime.bindingCalled",
    { name: OBSERVER_BINDING, payload, executionContextId: contextId },
    sessionId,
  );
}

const target = (handle: Instrumentation, id: string) =>
  handle.report().targets.find(({ sessionId }) => sessionId === id);

test("auto-attaches at the browser level, holding new targets", async () => {
  const { channel } = await start();
  expect(channel.sent).toEqual([
    {
      method: "Target.setAutoAttach",
      params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
    },
  ]);
});

test("a held page gets the hook, the binding, and nested auto-attach before it resumes", async () => {
  const { channel, handle } = await start();
  channel.attach("S1", { targetId: "T1", type: "page" });
  await handle.settled();
  expect(channel.methods("S1")).toEqual([...PAGE_ORDER, "Runtime.runIfWaitingForDebugger"]);
  const script = channel.sent.find(
    ({ method }) => method === "Page.addScriptToEvaluateOnNewDocument",
  );
  expect(script?.params).toMatchObject({ runImmediately: true });
  expect(String(script?.params?.source)).toContain('"targetId":"T1"');
  expect(channel.sent.find(({ method }) => method === "Runtime.addBinding")?.params).toEqual({
    name: OBSERVER_BINDING,
  });
  expect(target(handle, "S1")?.installMode).toBe("before-first-script");
  expect(target(handle, "S1")).not.toHaveProperty("error");
});

test("a running page is hooked late, in its current document, and not resumed", async () => {
  const { channel, handle } = await start();
  channel.attach("S1", { targetId: "T1", type: "iframe" }, false);
  await handle.settled();
  expect(channel.methods("S1")).toEqual(PAGE_ORDER);
  expect(channel.sent[3]?.params).toMatchObject({ runImmediately: true });
  expect(target(handle, "S1")?.installMode).toBe("late");
});

test("workers get the binding without a document hook; only dedicated workers auto-attach", async () => {
  const { channel, handle } = await start();
  channel.attach("W1", { targetId: "W", type: "worker" });
  channel.attach("SW", { targetId: "S", type: "service_worker" });
  await handle.settled();
  expect(channel.methods("W1")).toEqual([
    "Target.setAutoAttach",
    "Runtime.enable",
    "Runtime.addBinding",
    "Runtime.runIfWaitingForDebugger",
  ]);
  expect(channel.methods("SW")).toEqual([
    "Runtime.enable",
    "Runtime.addBinding",
    "Runtime.runIfWaitingForDebugger",
  ]);
  const report = handle.report();
  expect(report.dedicatedWorkers).toEqual({ observed: true });
  expect(report.serviceWorkers).toEqual({ observed: true });
});

test("other targets are only resumed, and a failed resume is tolerated", async () => {
  const { channel, handle } = await start();
  channel.failing.set("Runtime.runIfWaitingForDebugger", "Target closed");
  channel.attach("O1", { targetId: "O", type: "browser_ui" });
  channel.attach("O2", { targetId: "P", type: "other" }, false);
  await handle.settled();
  expect(channel.methods("O1")).toEqual(["Runtime.runIfWaitingForDebugger"]);
  expect(channel.methods("O2")).toEqual([]);
  expect(handle.report()).toMatchObject({
    targets: [{ installMode: "ignored" }, { installMode: "ignored" }],
    dedicatedWorkers: { observed: false },
    serviceWorkers: { observed: false },
  });
});

test("a failed install command is recorded on its target", async () => {
  const { channel, handle } = await start();
  channel.failing.set("Page.enable", "Page.enable failed: Not supported");
  channel.attach("S1", { targetId: "T1", type: "page" });
  await handle.settled();
  expect(channel.methods("S1")).toContain("Runtime.runIfWaitingForDebugger");
  expect(target(handle, "S1")?.error).toBe("Page.enable failed: Not supported");
});

test("an accepted message becomes an event tied to its target, frame, and document", async () => {
  const { channel, events, handle } = await start();
  channel.attach("S1", { targetId: "T1", type: "iframe" });
  context(channel, "S1", 7, "T1");
  call(channel, "S1", 7, message());
  call(channel, "S1", 7, message({ documentId: DOC.replace("0", "f"), ts: 99 }));
  expect(events).toEqual([
    {
      type: "document.hook-installed",
      source: "S1",
      seq: 1,
      at: NOW,
      targetId: "T1",
      sessionId: "S1",
      frameId: "T1",
      documentId: DOC,
      installMode: "before-first-script",
      hookSeq: 1,
      monotonicTimeMs: 12.5,
      url: "http://127.0.0.1:4600/routes/form",
    },
    expect.objectContaining({ seq: 2, monotonicTimeMs: 99 }),
  ]);
  for (const event of events) expect(v.is(InstrumentationEventSchema, event)).toBe(true);
  expect(target(handle, "S1")).toMatchObject({
    url: "http://127.0.0.1:4600/routes/form",
    hookInstalled: true,
    hookInstalls: 2,
  });
  expect(v.is(InstrumentationReportSchema, handle.report())).toBe(true);
});

test("a child frame's message keeps the target's URL and a worker's has no frame", async () => {
  const { channel, events, handle } = await start();
  channel.attach("S1", {
    targetId: "T1",
    type: "page",
    url: "http://127.0.0.1:4600/routes/iframe",
  });
  channel.attach("W1", { targetId: "W", type: "worker" });
  context(channel, "S1", 1, "CHILD");
  context(channel, "W1", 2);
  call(channel, "S1", 1, message());
  call(channel, "W1", 2, message({ targetId: "W" }));
  expect(events.map(({ frameId }) => frameId)).toEqual(["CHILD", null]);
  expect(target(handle, "S1")?.url).toBe("http://127.0.0.1:4600/routes/iframe");
});

test("invalid messages are dropped and counted, never parsed past the size limit", async () => {
  const { channel, events, handle } = await start();
  channel.attach("S1", { targetId: "T1", type: "page" });
  context(channel, "S1", 1, "T1");
  call(channel, "S1", 1, "{not json");
  call(channel, "S1", 1, JSON.stringify({ garbage: true }));
  call(channel, "S1", 1, message({ documentId: "not-hex" }));
  call(channel, "S1", 1, message({ payload: { url: "x".repeat(MAX_OBSERVER_MESSAGE_LENGTH) } }));
  expect(events).toEqual([]);
  expect(target(handle, "S1")).toMatchObject({ droppedInvalid: 4, hookInstalled: false });
});

test("messages from unknown contexts or claiming another target are dropped and counted", async () => {
  const { channel, events, handle } = await start();
  channel.attach("S1", { targetId: "T1", type: "page" });
  context(channel, "S1", 1, "T1");
  context(channel, "S1", 2, "T1");
  channel.emit("Runtime.executionContextDestroyed", { executionContextId: 2 }, "S1");
  call(channel, "S1", 2, message());
  call(channel, "S1", 9, message());
  call(channel, "S1", 1, message({ targetId: "FORGED" }));
  channel.emit("Runtime.executionContextsCleared", {}, "S1");
  call(channel, "S1", 1, message());
  expect(events).toEqual([]);
  expect(target(handle, "S1")).toMatchObject({ droppedInvalid: 0, droppedUnknownFrame: 4 });
});

test("ignores other bindings, unknown sessions, ignored targets, and malformed CDP events", async () => {
  const { channel, events, handle } = await start();
  channel.emit("Target.attachedToTarget", { sessionId: "S0" });
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.attach("O1", { targetId: "O", type: "other" });
  context(channel, "S1", 1, "T1");
  context(channel, "O1", 1, "O");
  channel.emit("Runtime.executionContextCreated", { context: {} }, "S1");
  channel.emit("Runtime.executionContextDestroyed", {}, "S1");
  channel.emit(
    "Runtime.bindingCalled",
    { name: "other", payload: message(), executionContextId: 1 },
    "S1",
  );
  channel.emit("Runtime.bindingCalled", { name: OBSERVER_BINDING }, "S1");
  call(channel, "UNKNOWN", 1, message());
  call(channel, "O1", 1, message({ targetId: "O" }));
  channel.emit("Page.frameNavigated", {}, "S1");
  channel.emit("Page.frameNavigated", {});
  call(channel, "S1", 1, message());
  expect(events).toHaveLength(1);
  expect(handle.report().targets).toHaveLength(2);
});

test("a detached session is marked and its later events are ignored", async () => {
  const { channel, events, handle } = await start();
  channel.attach("S1", { targetId: "T1", type: "page" });
  context(channel, "S1", 1, "T1");
  channel.emit("Target.detachedFromTarget", {});
  channel.emit("Target.detachedFromTarget", { sessionId: "UNKNOWN" });
  channel.emit("Target.detachedFromTarget", { sessionId: "S1" });
  call(channel, "S1", 1, message());
  expect(events).toEqual([]);
  expect(target(handle, "S1")?.detached).toBe(true);
});

test("instrument opens its own channel and stop closes it; events default to the clock", async () => {
  const channel = new FakeChannel();
  const events: InstrumentationEvent[] = [];
  const endpoints: string[] = [];
  const handle = await instrument("ws://127.0.0.1:9222/devtools/browser/x", {
    onEvent: (event) => events.push(event),
    openChannel: (endpoint) => {
      endpoints.push(endpoint);
      return Promise.resolve(channel);
    },
  });
  channel.attach("S1", { targetId: "T1", type: "page" });
  context(channel, "S1", 1, "T1");
  call(channel, "S1", 1, message());
  expect(endpoints).toEqual(["ws://127.0.0.1:9222/devtools/browser/x"]);
  expect(Date.parse(events[0]?.at ?? "")).not.toBeNaN();
  handle.stop();
  expect(channel.closed).toBe(true);
});

test("instrument without onEvent still counts installs", async () => {
  const channel = new FakeChannel();
  const handle = await instrument("ws://127.0.0.1:9222/devtools/browser/x", {
    openChannel: () => Promise.resolve(channel),
  });
  channel.attach("S1", { targetId: "T1", type: "page" });
  context(channel, "S1", 1, "T1");
  call(channel, "S1", 1, message());
  expect(target(handle, "S1")?.hookInstalls).toBe(1);
});

test("a failed start closes the channel it opened and rethrows", async () => {
  const channel = new FakeChannel();
  channel.failing.set("Target.setAutoAttach", "Not allowed");
  const opening = instrument("ws://127.0.0.1:9222/devtools/browser/x", {
    openChannel: () => Promise.resolve(channel),
    capture: { runId: "run-1", onEvent: () => undefined },
  });
  await expect(opening).rejects.toThrow("Not allowed");
  expect(channel.closed).toBe(true);
});

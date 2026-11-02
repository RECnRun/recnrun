import { HOOK_VERSION, InstrumentationReportSchema } from "@recnrun/protocol";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { NOW } from "./fake-cdp.ts";
import { capturing, DOC } from "./capture-harness.ts";

const installed = { kind: "lifecycle", type: "document.hook-installed" };
const hook = (url: string) => ({ ...installed, payload: { url, hookVersion: HOOK_VERSION } });

test("a captured page also enables the network and the log before it resumes", async () => {
  const { channel, handle } = await capturing();
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.attach("W1", { targetId: "W", type: "worker" });
  await handle.settled();
  expect(channel.methods("S1").slice(-3)).toEqual([
    "Network.enable",
    "Log.enable",
    "Runtime.runIfWaitingForDebugger",
  ]);
  expect(channel.methods("W1")).not.toContain("Network.enable");
});

test("target lifecycle and hook messages become envelopes numbered per producer", async () => {
  const { channel, events, handle } = await capturing();
  channel.attach("S1", { targetId: "T1", type: "page", url: "about:blank" });
  channel.emit("Target.attachedToTarget", {
    sessionId: "S2",
    targetInfo: { targetId: "T2", type: "page", url: "about:blank", openerId: "T1" },
    waitingForDebugger: false,
  });
  channel.context("S1", 3, "T1");
  channel.post("S1", 3, hook("http://127.0.0.1:4600/routes/form"));
  const click = { target: { tag: "button", testId: "submit" }, isTrusted: true, x: 1, y: 2 };
  channel.post("S1", 3, { kind: "dom", type: "click", seq: 2, ts: 9.5, payload: click });
  channel.emit("Target.detachedFromTarget", { sessionId: "S1" });
  expect(events).toEqual([
    {
      schemaVersion: 1,
      id: "cdp:browser#1",
      runId: "run-1",
      seq: 1,
      source: "browser",
      producer: "cdp:browser",
      timestamp: NOW,
      targetId: "T1",
      frameId: null,
      documentId: null,
      component: "browser",
      category: "target",
      type: "attached",
      payload: { type: "page", url: "about:blank", installMode: "before-first-script" },
    },
    expect.objectContaining({
      seq: 2,
      targetId: "T2",
      payload: expect.objectContaining({ openerId: "T1", installMode: "late" }),
    }),
    expect.objectContaining({
      id: "cdp:S1#1",
      source: "S1",
      frameId: "T1",
      documentId: DOC,
      monotonicTimeMs: 5,
      component: "collector",
      category: "target",
      type: "hook-installed",
      payload: { url: "http://127.0.0.1:4600/routes/form", hookVersion: HOOK_VERSION },
    }),
    expect.objectContaining({
      id: "cdp:S1#2",
      documentId: DOC,
      monotonicTimeMs: 9.5,
      category: "dom",
      type: "click",
      payload: click,
    }),
    expect.objectContaining({ id: "cdp:browser#3", targetId: "T1", type: "detached" }),
  ]);
  const report = handle.report();
  expect(report.capture).toEqual({ events: 5, dropped: 0 });
  expect(report.targets[0]).toMatchObject({ hookInstalls: 1 });
  expect(v.is(InstrumentationReportSchema, report)).toBe(true);
});

test("console calls, exceptions, and log entries name their frame and document", async () => {
  const { channel, events } = await capturing();
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.context("S1", 3, "CHILD");
  channel.post("S1", 3, hook("http://127.0.0.1:4600/routes/console"));
  const callFrames = [{ url: "http://x/console.js", lineNumber: 4, columnNumber: 9 }];
  channel.emit(
    "Runtime.consoleAPICalled",
    {
      type: "error",
      executionContextId: 3,
      stackTrace: { callFrames },
      args: [
        { type: "string", value: "Fixture error message" },
        { type: "number", value: 4 },
        { type: "number", unserializableValue: "NaN" },
        { type: "object", description: "Error: x" },
        { type: "undefined" },
      ],
    },
    "S1",
  );
  channel.emit(
    "Runtime.exceptionThrown",
    {
      exceptionDetails: {
        text: "Uncaught (in promise)",
        lineNumber: 0,
        columnNumber: 0,
        executionContextId: 3,
        exception: { type: "object", description: "Error: Rejected on purpose" },
      },
    },
    "S1",
  );
  channel.emit(
    "Runtime.exceptionThrown",
    { exceptionDetails: { text: "Uncaught", lineNumber: 1, columnNumber: 2 } },
    "S1",
  );
  channel.emit(
    "Log.entryAdded",
    {
      entry: {
        source: "network",
        level: "error",
        text: "500",
        url: "http://x/api",
        networkRequestId: "R1",
      },
    },
    "S1",
  );
  channel.emit("Log.entryAdded", { entry: { source: "other", level: "info", text: "t" } }, "S1");
  channel.emit("Runtime.consoleAPICalled", { type: "log" }, "S1");
  expect(events.slice(2)).toMatchObject([
    {
      frameId: "CHILD",
      documentId: DOC,
      category: "console",
      type: "api",
      payload: {
        level: "error",
        args: ["Fixture error message", "4", "NaN", "Error: x", "undefined"],
        url: "http://x/console.js",
        line: 5,
        column: 10,
      },
    },
    {
      frameId: "CHILD",
      documentId: DOC,
      category: "error",
      payload: {
        text: "Uncaught (in promise)",
        description: "Error: Rejected on purpose",
        line: 1,
      },
    },
    { frameId: null, documentId: null, payload: { text: "Uncaught", line: 2, column: 3 } },
    { type: "log", payload: { source: "network", url: "http://x/api", networkRequestId: "R1" } },
    { type: "log", payload: { source: "other", level: "info", text: "t" } },
  ]);
  expect(events).toHaveLength(7);
});

test("navigations and dialogs are mapped; ignored targets and unknown events are not", async () => {
  const { channel, of } = await capturing();
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.attach("O1", { targetId: "O", type: "other" });
  const frame = { id: "T1", url: "http://127.0.0.1:4600/routes/spa" };
  channel.emit("Page.frameNavigated", { frame }, "S1");
  channel.emit("Page.frameNavigated", { frame: { ...frame, id: "F2", parentId: "T1" } }, "S1");
  channel.emit("Page.navigatedWithinDocument", { frameId: "T1", url: `${frame.url}#b` }, "S1");
  channel.emit(
    "Page.javascriptDialogOpening",
    { url: frame.url, message: "Hi", type: "alert" },
    "S1",
  );
  channel.emit(
    "Page.javascriptDialogClosed",
    { result: false, userInput: "", frameId: "T1" },
    "S1",
  );
  channel.emit("Page.frameNavigated", { frame }, "O1");
  channel.emit("Page.loadEventFired", { timestamp: 1 }, "S1");
  for (const method of ["Page.frameNavigated", "Page.navigatedWithinDocument"])
    channel.emit(method, {}, "S1");
  for (const method of ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"])
    channel.emit(method, {}, "S1");
  expect(of("navigation")).toMatchObject([
    { frameId: "T1", type: "committed", payload: { url: frame.url } },
    { frameId: "F2", type: "committed", payload: { parentFrameId: "T1" } },
    { frameId: "T1", type: "same-document", payload: { url: `${frame.url}#b` } },
  ]);
  expect(of("dom")).toMatchObject([
    { frameId: null, type: "dialog-opening", payload: { dialogType: "alert", message: "Hi" } },
    { frameId: "T1", type: "dialog-closed", payload: { result: false, userInput: "" } },
  ]);
});

test("a draft that fails validation is dropped, counted, and leaves a sequence hole", async () => {
  const { channel, events, handle } = await capturing();
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.emit("Log.entryAdded", { entry: { source: "", level: "info", text: "x" } }, "S1");
  channel.emit(
    "Network.requestWillBeSent",
    { requestId: "", request: { url: "u", method: "GET" } },
    "S1",
  );
  channel.emit("Log.entryAdded", { entry: { source: "other", level: "info", text: "x" } }, "S1");
  expect(events.at(-1)).toMatchObject({ producer: "cdp:S1", seq: 2 });
  expect(handle.report().capture).toEqual({ events: 2, dropped: 1 });
});

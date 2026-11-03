import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { Stop } from "@/background/stop/types";
import { NOT_ALLOWED } from "./fake-debugger";
import { fakeStop, methods, OUTSIDE_TAB, TAB } from "./fake-stop";

// E1 recorded this refusal for Runtime.terminateExecution on a worker session (CAPABILITIES.md).
const TERMINATE_REFUSED =
  '{"code":-32000,"message":"Runtime.terminateExecution is not allowed for untrusted clients"}';

type Method = Exclude<keyof Stop, "watch" | "unwatch" | "unblock">;

afterEach(() => {
  vi.useRealTimers();
});

describe("stop mechanisms on a worker target", () => {
  test("closeTarget attaches to the worker, closes it on its own session, and detaches", async () => {
    const { engine, sent } = fakeStop();
    const journal = await engine.closeTarget({ targetId: "sw" });
    expect(sent).toEqual([
      { target: { targetId: "sw" }, method: "Target.closeTarget", params: { targetId: "sw" } },
    ]);
    expect(methods(journal)).toEqual([
      "debugger.getTargets",
      "debugger.attach",
      "debugger.Target.closeTarget",
      "debugger.detach",
      "debugger.getTargets",
    ]);
    expect(journal).toMatchObject({
      mechanism: "close-target",
      timeOrigin: 1_000,
      outcome: { via: "worker", success: true, listedAfter: false },
    });
  });

  test("every call carries its own start and end on the journal's clock", async () => {
    const { engine } = fakeStop();
    const journal = await engine.closeTarget({ targetId: "sw" });
    const times = journal.calls.flatMap((call) => [call.startedAt, call.endedAt]);
    expect(times.length).toBeGreaterThan(0);
    expect([journal.startedAt, ...times, journal.endedAt]).toEqual(
      [journal.startedAt, ...times, journal.endedAt].toSorted((a, b) => a - b),
    );
    expect(new Set(times).size).toBe(times.length);
  });

  test("closeTarget through the tab session names the worker and records Chrome's refusal", async () => {
    const { engine, sent } = fakeStop({ refused: { "Target.closeTarget": NOT_ALLOWED } });
    const journal = await engine.closeTarget({ targetId: "sw", via: "tab", tabId: TAB });
    expect(sent).toEqual([
      { target: { tabId: TAB }, method: "Target.closeTarget", params: { targetId: "sw" } },
    ]);
    const close = journal.calls.find((call) => call.method === "Target.closeTarget");
    expect(close?.error).toBe(NOT_ALLOWED);
    expect(journal.outcome).toMatchObject({ via: "tab", success: false, listedAfter: true });
  });

  test("a command Chrome never answers is recorded with its bound", async () => {
    vi.useFakeTimers();
    const { engine } = fakeStop({ hanging: ["Target.closeTarget"] });
    const closing = engine.closeTarget({ targetId: "sw" });
    await vi.runAllTimersAsync();
    const journal = await closing;
    const close = journal.calls.find((call) => call.method === "Target.closeTarget");
    expect(close?.error).toBe("Target.closeTarget: no reply within 5000 ms");
    expect(journal.outcome).toMatchObject({ success: false });
  });

  test("terminateExecution records Chrome's exact refusal and still detaches", async () => {
    const refused = { "Runtime.terminateExecution": TERMINATE_REFUSED };
    const { engine, sent } = fakeStop({ refused });
    const journal = await engine.terminateExecution({ targetId: "sw" });
    expect(sent.map((entry) => entry.method)).toEqual(["Runtime.terminateExecution"]);
    expect(methods(journal)).toEqual([
      "debugger.getTargets",
      "debugger.attach",
      "debugger.Runtime.terminateExecution",
      "debugger.detach",
    ]);
    expect(journal.calls[2]?.error).toBe(TERMINATE_REFUSED);
    expect(journal.outcome).toEqual({ terminated: false });
  });

  test("pauseHold pauses the worker on a forced statement until release resumes it", async () => {
    const { engine, sent } = fakeStop({ heldUntil: { "Runtime.evaluate": "Debugger.resume" } });
    const held = await engine.pauseHold({ targetId: "sw" });
    expect(sent.map((entry) => entry.method)).toEqual([
      "Debugger.enable",
      "Debugger.pause",
      "Runtime.evaluate",
    ]);
    expect(held.outcome).toMatchObject({ paused: true });
    const released = await engine.release({ targetId: "sw" });
    expect(sent.slice(3).map((entry) => entry.method)).toEqual([
      "Debugger.resume",
      "Debugger.disable",
    ]);
    expect(methods(released)).toEqual([
      "debugger.Debugger.resume",
      "debugger.Debugger.disable",
      "debugger.detach",
    ]);
    expect(released.outcome).toMatchObject({
      resumed: true,
      heldEvaluation: { result: { value: "/sw-main.js" } },
    });
  });

  test("pauseHold reports no pause when Chrome never sends Debugger.paused within its bound", async () => {
    vi.useFakeTimers();
    const { engine } = fakeStop({ muted: ["Debugger.paused"] });
    const holding = engine.pauseHold({ targetId: "sw" });
    await vi.runAllTimersAsync();
    expect((await holding).outcome).toMatchObject({ paused: false });
    await engine.release({ targetId: "sw" });
  });

  test("release refuses a worker that is not held", async () => {
    const { engine, sent } = fakeStop();
    await expect(engine.release({ targetId: "sw" })).rejects.toThrow("sw is not held");
    expect(sent).toEqual([]);
  });
});

describe("stop requests", () => {
  test.each<[Method, object]>([
    ["closeTarget", { targetId: "outside" }],
    ["closeTarget", { targetId: "sw", via: "tab", tabId: OUTSIDE_TAB }],
    ["terminateExecution", { targetId: "outside" }],
    ["pauseHold", { targetId: "outside" }],
    ["unregister", { tabId: OUTSIDE_TAB }],
    ["client", { tabId: OUTSIDE_TAB, action: "status" }],
    ["blockScope", { origin: "https://example.com" }],
  ])("%s refuses %j outside the loopback before any command", async (method, request) => {
    const { engine, sent, dnrCalls, removedTabs } = fakeStop();
    await expect(engine[method](request)).rejects.toThrow("not on the loopback");
    expect([sent, dnrCalls, removedTabs]).toEqual([[], [], []]);
  });

  test.each<[Method, object]>([
    ["closeTarget", {}],
    ["closeTarget", { targetId: "sw", via: "tab" }],
    ["closeTarget", { targetId: "sw", via: "browser" }],
    ["terminateExecution", { targetId: "" }],
    ["pauseHold", { targetId: "sw", extra: true }],
    ["unregister", { tabId: -1 }],
    ["client", { tabId: TAB, action: "sync", tag: "Not a tag!" }],
    ["client", { tabId: TAB, action: "evaluate" }],
    ["blockScope", { origin: "http://app.localhost:4600/path" }],
  ])("%s rejects the malformed request %j", async (method, request) => {
    const { engine, sent } = fakeStop();
    await expect(engine[method](request)).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  test("watch rejects a marker the bootstrap would refuse", () => {
    const { engine } = fakeStop();
    expect(() => engine.watch({ marker: 5 })).toThrow();
  });
});

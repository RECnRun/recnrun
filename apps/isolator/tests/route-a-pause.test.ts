import { withMarker } from "@recnrun/worker-bootstrap";
import { describe, expect, test } from "vite-plus/test";
import { NOT_ALLOWED } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";
import { INSTALLED, TAB, attached, on, setup } from "./route-a-setup";

const SW = { tabId: TAB, sessionId: "s-sw" };
const TYPEOF = { caches: "object", CacheStorage: "function" };
const PREPARE = [
  "Debugger.enable",
  "Debugger.setInstrumentationBreakpoint",
  "Target.setAutoAttach",
  "Runtime.runIfWaitingForDebugger",
];

/** An engine whose tab is armed with pauseBeforeScript, and whose `typeof` probe answers TYPEOF. */
async function armed(options: FakeOptions = {}) {
  const fake = setup({
    ...options,
    replies: {
      "Debugger.setInstrumentationBreakpoint": { breakpointId: "bp-1" },
      ...options.replies,
    },
  });
  const send = fake.api.sendCommand.bind(fake.api);
  fake.api.sendCommand = async (target, method, params) => {
    const reply = await send(target, method, params);
    const expression = String((params as { expression?: unknown } | undefined)?.expression);
    const probe = method === "Runtime.evaluate" && !expression.startsWith("(function");
    return probe ? { result: { type: "object", value: TYPEOF } } : reply;
  };
  await fake.engine.arm({ tabId: TAB, pauseBeforeScript: true });
  return fake;
}

describe("Route A pause before script", () => {
  test("sets an instrumentation breakpoint before it releases a waiting worker, and no bootstrap yet", async () => {
    const { engine, sent, emit } = await armed();
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    const [entry] = (await engine.journal()).entries;
    expect(on(sent, "s-sw")).toEqual(PREPARE);
    const breakpoint = sent.find((item) => item.method === "Debugger.setInstrumentationBreakpoint");
    expect(breakpoint?.params).toEqual({ instrumentation: "beforeScriptExecution" });
    expect([entry?.installed, entry?.released]).toEqual([undefined, true]);
    expect(entry?.pause).toEqual({
      steps: [
        { step: "Debugger.enable", result: "ok" },
        { step: "Debugger.setInstrumentationBreakpoint", result: "ok" },
      ],
      paused: false,
      breakpointId: "bp-1",
      laterPauses: 0,
    });
  });

  test("at the instrumentation pause reads typeof caches, bootstraps, removes the breakpoint, and resumes", async () => {
    const { engine, sent, emit } = await armed();
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    await engine.journal();
    emit(SW, "Debugger.paused", { reason: "instrumentation", data: { url: "sw.js" } });
    const [entry] = (await engine.journal()).entries;
    expect(on(sent, "s-sw").slice(PREPARE.length)).toEqual([
      "Runtime.evaluate",
      "Runtime.evaluate",
      "Debugger.removeBreakpoint",
      "Debugger.resume",
    ]);
    const evaluations = sent.filter((item) => item.method === "Runtime.evaluate");
    expect(evaluations[1]?.params).toMatchObject({ expression: withMarker("m1") });
    expect(entry).toMatchObject({ installed: INSTALLED, bootstrapMs: expect.any(Number) });
    expect(entry?.pause).toMatchObject({ paused: true, typeofAtPause: TYPEOF, laterPauses: 0 });
    expect(entry?.pause?.steps.slice(2)).toEqual([
      { step: "Debugger.paused", result: "instrumentation sw.js" },
      { step: "Runtime.evaluate typeof", result: "ok" },
      { step: "Debugger.removeBreakpoint", result: "ok" },
      { step: "Debugger.resume", result: "ok" },
    ]);
  });

  test("resumes a later pause at once and counts it", async () => {
    const { engine, sent, emit } = await armed();
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    emit(SW, "Debugger.paused", { reason: "instrumentation" });
    await engine.journal();
    emit(SW, "Debugger.paused", { reason: "other" });
    const [entry] = (await engine.journal()).entries;
    expect(on(sent, "s-sw").at(-1)).toBe("Debugger.resume");
    expect(on(sent, "s-sw").filter((method) => method === "Runtime.evaluate")).toHaveLength(2);
    expect(entry?.pause?.laterPauses).toBe(1);
  });

  test("keeps Chrome's exact error for a refused breakpoint and still releases the worker", async () => {
    const { engine, emit } = await armed({
      refused: { "Debugger.setInstrumentationBreakpoint": NOT_ALLOWED },
    });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    const [entry] = (await engine.journal()).entries;
    expect(entry?.pause?.steps).toContainEqual({
      step: "Debugger.setInstrumentationBreakpoint",
      result: NOT_ALLOWED,
    });
    expect(entry?.released).toBe(true);
  });

  test("bootstraps a worker attached while running at once, without a pause", async () => {
    const { engine, sent, emit } = await armed();
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("worker", "run", "s-run", false));
    const [entry] = (await engine.journal()).entries;
    expect(on(sent, "s-run")).toEqual(["Runtime.evaluate", "Target.setAutoAttach"]);
    expect([entry?.installed, entry?.pause]).toEqual([INSTALLED, undefined]);
  });

  test("ignores a pause on a session it did not prepare and rejects a non-boolean option", async () => {
    const { engine, sent, emit } = await armed();
    emit({ tabId: TAB, sessionId: "s-unknown" }, "Debugger.paused", { reason: "instrumentation" });
    expect((await engine.journal()).entries).toEqual([]);
    expect(sent.filter((item) => item.method.startsWith("Debugger."))).toEqual([]);
    const other = setup();
    await expect(other.engine.arm({ tabId: TAB, pauseBeforeScript: "yes" })).rejects.toThrow(
      "expected { tabId: <integer> }",
    );
  });
});

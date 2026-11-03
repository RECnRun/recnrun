import { describe, expect, test } from "vite-plus/test";
import { EVENT_LIMIT } from "@/background/route-a/events";
import { NOT_ALLOWED } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";
import { APP, TAB, TARGETS, attached, setup } from "./route-a-setup";

/** closeTarget looks its target up first, so the workers these tests close are listed. */
function listing(options: FakeOptions = {}) {
  const workers = [
    { type: "service_worker", id: "sw", url: `${APP}/sw.js`, attached: true },
    { type: "worker", id: "w", url: `${APP}/w.js`, attached: true },
  ];
  return setup({ ...options, targets: [...TARGETS, ...workers] });
}

describe("Route A target events", () => {
  test("journals each Target event on the tab and its child sessions, in arrival order", async () => {
    const { engine, emit } = setup();
    await engine.arm({ tabId: TAB });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    emit({ tabId: TAB }, "Target.detachedFromTarget", { sessionId: "s-sw", targetId: "sw" });
    emit({ tabId: TAB, sessionId: "s-sw" }, "Target.targetInfoChanged", {
      targetInfo: { targetId: "sw", type: "service_worker", attached: true },
    });
    emit({ tabId: TAB }, "Runtime.consoleAPICalled", {});
    const { events } = await engine.journal();
    expect(events).toEqual([
      {
        at: 5,
        method: "Target.attachedToTarget",
        sessionId: "s-sw",
        targetId: "sw",
        waitingForDebugger: true,
      },
      { at: 10, method: "Target.detachedFromTarget", sessionId: "s-sw", targetId: "sw" },
      {
        at: 15,
        method: "Target.targetInfoChanged",
        via: "s-sw",
        targetId: "sw",
        detail: "attached",
      },
    ]);
  });

  test("keeps only the most recent events and counts the dropped ones until disarm", async () => {
    const { engine, emit } = setup();
    await engine.arm({ tabId: TAB });
    for (let i = 0; i < EVENT_LIMIT + 5; i += 1) {
      emit({ tabId: TAB }, "Target.detachedFromTarget", { sessionId: `s-${i}`, targetId: "sw" });
    }
    const journal = await engine.journal();
    expect(journal.events).toHaveLength(EVENT_LIMIT);
    expect(journal.events[0]?.sessionId).toBe("s-5");
    expect(journal.eventsDropped).toBe(5);
    await engine.disarm({ tabId: TAB });
    expect((await engine.journal()).eventsDropped).toBeUndefined();
  });

  test("detaches the tab's child session on a closed worker, so its restart is bootstrapped and released", async () => {
    const { engine, emit, restart, sent } = listing();
    await engine.arm({ tabId: TAB, pauseBeforeScript: true });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    await engine.journal();
    const report = await engine.closeTarget({ targetId: "sw" });
    expect(restart("sw", "s-sw-2"), "the restart reached Route A").toBe(true);
    emit({ tabId: TAB, sessionId: "s-sw-2" }, "Debugger.paused", { reason: "instrumentation" });
    const restarted = (await engine.journal()).entries.at(-1);
    expect(sent.filter(({ method }) => method === "Target.detachFromTarget")).toEqual([
      { target: { tabId: TAB }, method: "Target.detachFromTarget", params: { sessionId: "s-sw" } },
    ]);
    expect(report.sessions).toEqual([{ sessionId: "s-sw", detach: "ok" }]);
    expect(restarted).toMatchObject({ sessionId: "s-sw-2", marker: "m1", released: true });
    expect(restarted?.pause?.paused).toBe(true);
  });

  test("keeps Chrome's error when a child session will not detach, and skips it after a failed close", async () => {
    const error = '{"code":-32602,"message":"No session with given id"}';
    const refused = listing({ refused: { "Target.detachFromTarget": error } });
    await refused.engine.arm({ tabId: TAB });
    refused.emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s"));
    expect((await refused.engine.closeTarget({ targetId: "sw" })).sessions).toEqual([
      { sessionId: "s", detach: error },
    ]);
    const kept = listing({ refused: { "Target.closeTarget": NOT_ALLOWED } });
    await kept.engine.arm({ tabId: TAB });
    kept.emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s"));
    expect((await kept.engine.closeTarget({ targetId: "sw" })).sessions).toEqual([]);
  });

  test("forgets a child session Chrome detached or a disarmed tab dropped", async () => {
    const { engine, emit, sent } = listing();
    await engine.arm({ tabId: TAB });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("worker", "w", "s-w"));
    emit({ tabId: TAB }, "Target.detachedFromTarget", { sessionId: "s-sw", targetId: "sw" });
    expect((await engine.closeTarget({ targetId: "sw" })).sessions).toEqual([]);
    await engine.disarm({ tabId: TAB });
    expect((await engine.closeTarget({ targetId: "w" })).sessions).toEqual([]);
    expect(sent.filter(({ method }) => method === "Target.detachFromTarget")).toEqual([]);
  });

  test("journals onDetach and times closeTarget's steps on the same clock", async () => {
    const { engine, onDetach } = setup();
    await engine.arm({ tabId: TAB });
    onDetach.set.forEach((listener) => listener({ targetId: "shared" }, "target_closed"));
    const report = await engine.closeTarget({ targetId: "shared" });
    expect(report.at).toEqual({ start: 10, closed: 15, detached: 25 });
    expect((await engine.journal()).events).toEqual([
      { at: 5, method: "onDetach", targetId: "shared", detail: "target_closed" },
      // The fake reports the extension's own detach, which Chrome does not (E1).
      { at: 20, method: "onDetach", targetId: "shared", detail: "canceled_by_user" },
    ]);
  });
});

import { describe, expect, test } from "vite-plus/test";
import { TAB, attached, setup } from "./route-a-setup";

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

import { withMarker } from "@recnrun/worker-bootstrap";
import { describe, expect, test } from "vite-plus/test";
import { APP, fakeStop, methods, TAB } from "./fake-stop";

const ALREADY_ATTACHED = "Another debugger is already attached to the tab with id: 7.";
const NAVIGATE_REFUSED = "TypeError: Failed to execute 'navigate' on 'WindowClient'";

function evaluateReply(value: unknown) {
  return { replies: { "Runtime.evaluate": { result: { type: "object", value } } } };
}

function expressionOf(sent: ReturnType<typeof fakeStop>["sent"], index = 0): string {
  return String((sent[index]?.params as { expression?: unknown } | undefined)?.expression);
}

describe("DNR block and client eviction", () => {
  test("blockScope blocks the origin's service-worker scripts, evicts its clients, and closes the tabs left", async () => {
    const clients = [{ url: `${APP}/sw.html?sw=classic`, error: NAVIGATE_REFUSED }];
    const { engine, sent, rules, removedTabs } = fakeStop(evaluateReply(clients));
    const journal = await engine.blockScope({ origin: APP });

    const [rule] = [...rules.values()];
    expect(rule?.action).toEqual({ type: "block" });
    const blocked = new RegExp(rule?.condition.regexFilter ?? "^$");
    expect(blocked.test(`${APP}/sw-main.js?variant=classic`)).toBe(true);
    expect(blocked.test(`${APP}/sw-imports.js?variant=imports`)).toBe(true);
    expect(blocked.test(`${APP}/index.js`)).toBe(false);
    expect(blocked.test("http://app.localhost:46001/sw-main.js")).toBe(false);
    expect(blocked.test(`http://example.com/?${APP}/sw-main.js`)).toBe(false);

    expect(sent.map((entry) => [entry.target, entry.method])).toEqual([
      [{ targetId: "sw" }, "Runtime.evaluate"],
    ]);
    expect(expressionOf(sent)).toContain("clients.matchAll");
    expect(expressionOf(sent)).toContain('navigate("about:blank")');
    expect(removedTabs).toEqual([TAB]);
    expect(methods(journal)).toEqual([
      "declarativeNetRequest.updateSessionRules",
      "debugger.getTargets",
      "debugger.attach",
      "debugger.Runtime.evaluate",
      "debugger.detach",
      "tabs.query",
      "tabs.remove",
    ]);
    expect(journal.outcome).toMatchObject({
      ruleId: rule?.id,
      workers: [{ targetId: "sw", clients }],
      closedTabs: [TAB],
      evictedBy: "tabs.remove",
    });
  });

  test("blockScope credits client.navigate when no tab is left on the origin", async () => {
    const clients = [{ url: `${APP}/sw.html?sw=classic`, navigated: true }];
    const { engine, removedTabs } = fakeStop({ ...evaluateReply(clients), openTabs: [] });
    const journal = await engine.blockScope({ origin: APP });
    expect(removedTabs).toEqual([]);
    expect(methods(journal)).not.toContain("tabs.remove");
    expect(journal.outcome).toMatchObject({ closedTabs: [], evictedBy: "client.navigate" });
  });

  test("unblock removes every rule blockScope added", async () => {
    const { engine, rules } = fakeStop(evaluateReply([]));
    await engine.blockScope({ origin: APP });
    const journal = await engine.unblock();
    expect(rules.size).toBe(0);
    expect(journal.outcome).toEqual({ removed: [1] });
    expect((await engine.unblock()).outcome).toEqual({ removed: [] });
  });
});

describe("evaluation on a client tab", () => {
  test("unregister evaluates getRegistration().unregister() on the tab, borrowing the attach", async () => {
    const { engine, sent } = fakeStop(evaluateReply(true));
    const journal = await engine.unregister({ tabId: TAB });
    expect(sent).toEqual([
      {
        target: { tabId: TAB },
        method: "Runtime.evaluate",
        params: {
          expression:
            'navigator.serviceWorker.getRegistration().then((r) => (r ? r.unregister() : "no registration"))',
          awaitPromise: true,
          returnByValue: true,
        },
      },
    ]);
    expect(methods(journal)).toEqual([
      "debugger.getTargets",
      "debugger.attach",
      "debugger.Runtime.evaluate",
      "debugger.detach",
    ]);
    expect(journal.outcome).toEqual({ value: true });
  });

  test("unregister sends on a tab another session of the isolator holds, and leaves it attached", async () => {
    const { engine, sent } = fakeStop({ ...evaluateReply(true), attachError: ALREADY_ATTACHED });
    const journal = await engine.unregister({ tabId: TAB });
    expect(sent.map((entry) => entry.method)).toEqual(["Runtime.evaluate"]);
    expect(journal.calls[1]?.error).toBe(ALREADY_ATTACHED);
    expect(methods(journal)).not.toContain("debugger.detach");
    expect(journal.outcome).toEqual({ value: true });
  });

  test("an exception in the page is the outcome's error", async () => {
    const exceptionDetails = { text: "Uncaught", exception: { description: "TypeError: boom" } };
    const { engine } = fakeStop({ replies: { "Runtime.evaluate": { exceptionDetails } } });
    expect((await engine.unregister({ tabId: TAB })).outcome).toEqual({ error: "TypeError: boom" });
  });

  test.each([
    ["status", ["getRegistration()", "getTags()", "controller"]],
    ["post-message", ["controller.postMessage", "startMessages()", "no reply within"]],
    ["update", ["update()"]],
  ])("client %s evaluates a fixed expression on the tab", async (action, parts) => {
    const { engine, sent } = fakeStop(evaluateReply({ ok: true }));
    const journal = await engine.client({ tabId: TAB, action });
    expect(sent.map((entry) => [entry.target, entry.method])).toEqual([
      [{ tabId: TAB }, "Runtime.evaluate"],
    ]);
    for (const part of parts) expect(expressionOf(sent)).toContain(part);
    expect(journal).toMatchObject({
      mechanism: `client:${action}`,
      outcome: { value: { ok: true } },
    });
  });

  test("client sync registers the tag it was given", async () => {
    const { engine, sent } = fakeStop(evaluateReply({ registered: "e4-sync-1" }));
    await engine.client({ tabId: TAB, action: "sync", tag: "e4-sync-1" });
    expect(expressionOf(sent)).toContain('sync.register("e4-sync-1")');
  });
});

describe("restart watch", () => {
  test("bootstraps and releases a worker reloaded under a session, and records the Inspector events", async () => {
    const { engine, sent, emit } = fakeStop(evaluateReply({ marker: "m2" }));
    const session = { tabId: TAB, sessionId: "s-sw" };
    engine.watch({ marker: "m2" });
    emit(session, "Inspector.targetCrashed");
    emit(session, "Inspector.targetReloadedAfterCrash");
    emit({ tabId: TAB }, "Network.requestWillBeSent", {});
    const journal = await engine.unwatch();
    expect(sent.map((entry) => [entry.target, entry.method])).toEqual([
      [session, "Runtime.evaluate"],
      [session, "Runtime.runIfWaitingForDebugger"],
    ]);
    expect(expressionOf(sent)).toBe(withMarker("m2"));
    expect(journal.events.map((event) => event.method)).toEqual([
      "Inspector.targetCrashed",
      "Inspector.targetReloadedAfterCrash",
    ]);
    expect(journal.events[1]).toMatchObject({
      bootstrap: { installed: { marker: "m2" } },
      released: "ok",
    });
    emit(session, "Inspector.targetReloadedAfterCrash");
    expect(sent).toHaveLength(2);
  });

  test("without a marker it only records", async () => {
    const { engine, sent, emit } = fakeStop();
    engine.watch({});
    emit({ tabId: TAB, sessionId: "s-sw" }, "Inspector.targetReloadedAfterCrash");
    const journal = await engine.unwatch();
    expect(sent).toEqual([]);
    expect(journal.events).toHaveLength(1);
  });
});

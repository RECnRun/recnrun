import { BOOTSTRAP_HASH } from "@recnrun/worker-bootstrap";
import { describe, expect, test } from "vite-plus/test";
import { RouteBEngine } from "@/background/route-b/engine";
import { fakeDebugger } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";

const TAB = 7;
const ARM = { tabId: TAB, marker: "m1", urlPattern: "*/sw-*.js*" };
const FOUND = { updatefound: false, installing: false, waiting: false, active: "/sw-main.js" };

function setup(options: FakeOptions = {}) {
  const fake = fakeDebugger({
    ...options,
    replies: {
      "Runtime.evaluate": { result: { type: "object", value: FOUND } },
      ...options.replies,
    },
  });
  const engine = new RouteBEngine(
    () => fake.api,
    () => "chrome-extension://isolator/",
  );
  return { ...fake, engine };
}

const attached = {
  sessionId: "s-late",
  waitingForDebugger: true,
  targetInfo: { targetId: "late", type: "service_worker", url: "http://app.localhost:4600/sw.js" },
};

describe("Route B harness calls", () => {
  test("disarm detaches the tab, returns the journal, and clears it", async () => {
    const { engine, emit, onDetach } = setup();
    const detached: unknown[] = [];
    onDetach.addListener((source) => detached.push(source));
    await engine.arm(ARM);
    const journal = await engine.disarm({ tabId: TAB });
    expect(journal).toMatchObject({
      bootstrap: { hash: BOOTSTRAP_HASH },
      tabs: [{ tabId: TAB, marker: "m1", fetchEnable: "ok" }],
    });
    expect(detached).toEqual([{ tabId: TAB }]);
    emit({ tabId: TAB }, "Target.attachedToTarget", attached);
    expect(await engine.journal()).toMatchObject({ tabs: [], workers: [], paused: [] });
  });

  test("ignores the targets and requests of other tabs", async () => {
    const { engine, emit } = setup();
    await engine.arm(ARM);
    emit({ tabId: 8 }, "Target.attachedToTarget", attached);
    emit({ tabId: 8, sessionId: "s-other" }, "Fetch.requestPaused", { requestId: "r" });
    emit({ tabId: TAB }, "Fetch.requestPaused", { requestId: 1 });
    expect(await engine.journal()).toMatchObject({ workers: [], paused: [] });
  });

  test("update calls registration.update() in the armed tab's page and returns what it found", async () => {
    const { engine, sent } = setup();
    await engine.arm(ARM);
    expect(await engine.update({ tabId: TAB })).toEqual(FOUND);
    const evaluate = sent.at(-1);
    expect([evaluate?.target, evaluate?.method]).toEqual([{ tabId: TAB }, "Runtime.evaluate"]);
    expect(evaluate?.params).toMatchObject({ awaitPromise: true, returnByValue: true });
    expect(String(evaluate?.params && Reflect.get(evaluate.params, "expression"))).toContain(
      "registration.update()",
    );
    const thrown = setup({
      replies: { "Runtime.evaluate": { exceptionDetails: { text: "Uncaught (in promise)" } } },
    });
    await thrown.engine.arm(ARM);
    expect(await thrown.engine.update({ tabId: TAB })).toEqual({ error: "Uncaught (in promise)" });
  });

  test("stopWorker closes the worker through its own session", async () => {
    const { engine, sent, api } = setup();
    expect(await engine.stopWorker({ targetId: "sw" })).toEqual({ success: true });
    expect(sent.map(({ target, method, params }) => [target, method, params])).toEqual([
      [{ targetId: "sw" }, "Target.closeTarget", { targetId: "sw" }],
    ]);
    expect((await api.getTargets()).map((target) => target.id)).not.toContain("sw");
  });

  test("validates what the harness passes", async () => {
    const { engine } = setup();
    await expect(engine.arm({ ...ARM, tabId: "7" })).rejects.toThrow("expected { tabId, marker");
    await expect(engine.arm({ ...ARM, marker: "a:b" })).rejects.toThrow("expected { tabId, marker");
    await expect(engine.arm({ tabId: TAB, marker: "m1" })).rejects.toThrow("urlPattern");
    await expect(engine.stopWorker({})).rejects.toThrow("expected { targetId: <string> }");
    await expect(engine.disarm({ tabId: TAB })).rejects.toThrow("tab 7 is not armed");
    await expect(engine.update({ tabId: TAB })).rejects.toThrow("tab 7 is not armed");
    await engine.arm(ARM);
    await expect(engine.arm(ARM)).rejects.toThrow("tab 7 is already armed");
  });
});

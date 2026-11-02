import { withMarker } from "@recnrun/worker-bootstrap";
import { describe, expect, test } from "vite-plus/test";
import { RouteAEngine } from "@/background/route-a/engine";
import type { TargetInfo } from "@/background/probes/types";
import { fakeDebugger, NOT_ALLOWED } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";

const APP = "http://app.localhost:4600";
const TAB = 7;
const TARGETS: TargetInfo[] = [
  { type: "page", id: "page", url: `${APP}/workers.html?type=classic`, attached: true, tabId: TAB },
  { type: "other", id: "dedicated", url: `${APP}/worker.js?type=classic`, attached: true },
  { type: "worker", id: "shared", url: `${APP}/shared-worker.js?type=classic`, attached: false },
  { type: "worker", id: "elsewhere", url: "http://idp.localhost:4602/sw.js", attached: false },
];
const INSTALLED = { marker: "m1", installedAt: 1 };

function setup(options: FakeOptions = {}) {
  const fake = fakeDebugger({
    targets: TARGETS,
    ...options,
    replies: {
      "Runtime.evaluate": { result: { type: "object", value: INSTALLED } },
      ...options.replies,
    },
  });
  let clock = 0;
  const engine = new RouteAEngine(
    () => fake.api,
    () => (clock += 5),
  );
  engine.setMarker("m1");
  return { ...fake, engine };
}

function attached(type: string, targetId: string, sessionId: string, waiting = true) {
  return {
    sessionId,
    waitingForDebugger: waiting,
    targetInfo: { targetId, type, url: `${APP}/${targetId}.js` },
  };
}

/** Commands sent on one flattened session, in order. */
function on(sent: ReturnType<typeof fakeDebugger>["sent"], sessionId: string): string[] {
  return sent.filter((entry) => entry.target.sessionId === sessionId).map((entry) => entry.method);
}

describe("Route A auto-attach", () => {
  test("arms the tab with auto-attach that pauses every new target", async () => {
    const { engine, sent } = setup();
    await engine.arm({ tabId: TAB });
    expect(sent).toEqual([
      {
        target: { tabId: TAB },
        method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      },
    ]);
  });

  test("evaluates the bootstrap with the current marker before it releases a paused worker", async () => {
    const { engine, sent, emit } = setup();
    await engine.arm({ tabId: TAB });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    const { entries } = await engine.journal();
    expect(on(sent, "s-sw")).toEqual([
      "Runtime.evaluate",
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
    const evaluate = sent.find((entry) => entry.method === "Runtime.evaluate");
    expect(evaluate?.params).toMatchObject({ expression: withMarker("m1"), returnByValue: true });
    expect(entries).toEqual([
      {
        sessionId: "s-sw",
        targetId: "sw",
        type: "service_worker",
        url: `${APP}/sw.js`,
        waitingForDebugger: true,
        attachedAt: 5,
        marker: "m1",
        bootstrapMs: 5,
        installed: INSTALLED,
        autoAttach: "ok",
        released: true,
      },
    ]);
  });

  // The 5 s command timeout answers first when the release waits for the bootstrap's reply.
  test(
    "releases a service worker that answers the bootstrap only once released",
    {
      timeout: 10_000,
    },
    async () => {
      const heldUntil = { "Runtime.evaluate": "Runtime.runIfWaitingForDebugger" };
      const { engine, sent, emit } = setup({ heldUntil });
      await engine.arm({ tabId: TAB });
      emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
      const [entry] = (await engine.journal()).entries;
      expect(on(sent, "s-sw")).toEqual([
        "Runtime.evaluate",
        "Target.setAutoAttach",
        "Runtime.runIfWaitingForDebugger",
      ]);
      expect([entry?.error, entry?.installed, entry?.released]).toEqual([
        undefined,
        INSTALLED,
        true,
      ]);
    },
  );

  test("bootstraps a nested worker through the session of the worker that started it", async () => {
    const { engine, sent, emit } = setup();
    await engine.arm({ tabId: TAB });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("worker", "outer", "s-outer"));
    emit(
      { tabId: TAB, sessionId: "s-outer" },
      "Target.attachedToTarget",
      attached("worker", "inner", "s-inner"),
    );
    const { entries } = await engine.journal();
    expect(on(sent, "s-outer")).toContain("Target.setAutoAttach");
    expect(on(sent, "s-inner")).toEqual([
      "Runtime.evaluate",
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(entries.map(({ targetId, parentSessionId }) => ({ targetId, parentSessionId }))).toEqual(
      [{ targetId: "outer" }, { targetId: "inner", parentSessionId: "s-outer" }],
    );
  });

  test("releases an iframe without a bootstrap and leaves a running worker alone", async () => {
    const { engine, sent, emit } = setup();
    await engine.arm({ tabId: TAB });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("iframe", "frame", "s-frame"));
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("worker", "running", "s-run", false));
    const { entries } = await engine.journal();
    expect(on(sent, "s-frame")).toEqual([
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(on(sent, "s-run")).toEqual(["Runtime.evaluate", "Target.setAutoAttach"]);
    expect(entries.map((entry) => [entry.targetId, entry.marker, entry.released])).toEqual([
      ["frame", undefined, true],
      ["running", "m1", false],
    ]);
  });

  test("lists the shared worker that auto-attach never reported as unattached", async () => {
    const { engine, emit } = setup();
    await engine.arm({ tabId: TAB });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("worker", "dedicated", "s-ded"));
    const { unattached } = await engine.journal();
    expect(unattached).toEqual([
      { targetId: "shared", type: "worker", url: `${APP}/shared-worker.js?type=classic` },
    ]);
  });

  test("keeps Chrome's error and exception texts exactly and still releases the worker", async () => {
    const exception = { text: "Uncaught", exception: { description: "ReferenceError: x" } };
    const refused = setup({ refused: { "Runtime.evaluate": NOT_ALLOWED } });
    const thrown = setup({ replies: { "Runtime.evaluate": { exceptionDetails: exception } } });
    for (const { engine, emit } of [refused, thrown]) {
      await engine.arm({ tabId: TAB });
      emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    }
    const [failed] = (await refused.engine.journal()).entries;
    const [threw] = (await thrown.engine.journal()).entries;
    expect([failed?.error, failed?.released, failed?.installed]).toEqual([
      NOT_ALLOWED,
      true,
      undefined,
    ]);
    expect([threw?.error, threw?.released]).toEqual(["ReferenceError: x", true]);
  });

  test("ignores other tabs and other events", async () => {
    const { engine, emit } = setup();
    await engine.arm({ tabId: TAB });
    emit({ tabId: 8 }, "Target.attachedToTarget", attached("worker", "other", "s-other"));
    emit({ tabId: TAB }, "Target.detachedFromTarget", { sessionId: "s-other" });
    emit({ tabId: TAB }, "Target.attachedToTarget", { sessionId: "s-bad" });
    expect((await engine.journal()).entries).toEqual([]);
  });
});

describe("Route A harness calls", () => {
  test("disarm detaches the tab and direct targets, returns the journal, and clears it", async () => {
    const { engine, emit, onDetach } = setup();
    const detached: unknown[] = [];
    onDetach.addListener((source) => detached.push(source));
    await engine.arm({ tabId: TAB });
    await engine.attachTarget({ targetId: "shared" });
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("worker", "dedicated", "s-ded"));
    const journal = await engine.disarm({ tabId: TAB });
    expect(journal.entries.map((entry) => entry.targetId)).toEqual(["shared", "dedicated"]);
    expect(detached).toEqual([{ tabId: TAB }, { targetId: "shared" }]);
    expect((await engine.journal()).entries).toEqual([]);
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("worker", "late", "s-late"));
    expect((await engine.journal()).entries).toEqual([]);
  });

  test("attachTarget attaches by id and evaluates the bootstrap on that target", async () => {
    const { engine, sent } = setup();
    const entry = await engine.attachTarget({ targetId: "shared" });
    expect(sent.map((item) => [item.target, item.method])).toEqual([
      [{ targetId: "shared" }, "Runtime.evaluate"],
    ]);
    expect(entry).toMatchObject({
      sessionId: "",
      targetId: "shared",
      type: "worker",
      url: `${APP}/shared-worker.js?type=classic`,
      waitingForDebugger: false,
      marker: "m1",
      installed: INSTALLED,
      released: false,
    });
  });

  test("clearOrigin clears workers and storage of the tab's loopback origin only", async () => {
    const { engine, sent } = setup();
    expect(await engine.clearOrigin({ tabId: TAB })).toEqual({ origin: APP });
    expect(sent).toEqual([
      {
        target: { tabId: TAB },
        method: "Storage.clearDataForOrigin",
        params: { origin: APP, storageTypes: "service_workers,indexeddb,cache_storage" },
      },
    ]);
    const outside = setup({
      targets: [{ ...TARGETS[0], url: "https://example.com/" } as TargetInfo],
    });
    await expect(outside.engine.clearOrigin({ tabId: TAB })).rejects.toThrow(
      "refuses to clear https://example.com, which is not on the loopback",
    );
    expect(outside.sent).toEqual([]);
  });

  test("validates what the harness passes", async () => {
    const { engine } = setup();
    expect(() => engine.setMarker("a:b")).toThrow();
    await expect(engine.arm({ tabId: "7" })).rejects.toThrow("expected { tabId: <integer> }");
    await expect(engine.attachTarget({})).rejects.toThrow("expected { targetId: <string> }");
    await expect(engine.disarm({ tabId: TAB })).rejects.toThrow("tab 7 is not armed");
    await engine.arm({ tabId: TAB });
    await expect(engine.arm({ tabId: TAB })).rejects.toThrow("tab 7 is already armed");
    const unset = new RouteAEngine(() => fakeDebugger().api);
    await expect(unset.arm({ tabId: TAB })).rejects.toThrow("setMarker() first");
  });

  test("lists the open tabs", async () => {
    const { engine } = setup();
    expect(await engine.tabs()).toEqual([{ tabId: TAB, url: `${APP}/workers.html?type=classic` }]);
  });
});

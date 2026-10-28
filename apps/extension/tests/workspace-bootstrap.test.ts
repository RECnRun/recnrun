import type { IdentityData, WorkspaceOperation } from "@recnrun/domain";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { BOOTSTRAP_STEPS, bootstrapIdentity } from "@/background/workspace/bootstrap";
import type { BootstrapDeps } from "@/background/workspace/bootstrap";
import { WorkspaceError } from "@/background/workspace/errors";
import { fakeBarrierApi } from "./fake-barrier";
import type { FakeBarrierApi } from "./fake-barrier";
import { fakeCookieApi, memoryStoreMemory } from "./fake-cookies";
import type { FakeCookieApi } from "./fake-cookies";
import { fakeNavigationApi } from "./fake-navigation";
import type { FakeNavigationApi } from "./fake-navigation";
import { echoProbes, fakePort } from "./fake-port";

const ORIGIN = "http://app.localhost:5192";
const URL_ = `${ORIGIN}/app/redirect?run=1`;
const WINDOW = { generation: 2, windowId: 5, tabId: 9, status: "active" as const };
const DATA: IdentityData = {
  cookies: [{ name: "sid", value: "s", path: "/", secure: false, httpOnly: true, sameSite: "lax" }],
  site: { localStorage: { theme: "dark" }, sessionStorage: {}, indexedDB: [], caches: [] },
};
const COUNTS = {
  localStorage: 1,
  sessionStorage: 0,
  databases: 0,
  records: 0,
  caches: 0,
  cacheEntries: 0,
};

interface Seen {
  cookiesAtNavigation: number;
  rulesAtNavigation: number;
  rulesAtReload: number;
  scriptsAtReload: number;
  restorePayload: unknown;
}

let cookies: FakeCookieApi;
let navigation: FakeNavigationApi;
let barrier: FakeBarrierApi;
let records: WorkspaceOperation[];
let seen: Seen;
let deps: BootstrapDeps;

/** The origin agent's port: connects on navigation, echoes the probe, and answers the restore. */
function connectAgent(reply: "restored" | "failed" = "restored") {
  const agent = fakePort({ tab: { id: 9 }, frameId: 0, documentId: "doc-1", origin: ORIGIN });
  agent.postMessage = (message: unknown) => {
    const { operationId, generation, payload } = message as Record<string, unknown>;
    seen.restorePayload = payload;
    const answer = reply === "restored" ? { counts: COUNTS } : { error: "QuotaExceededError" };
    queueMicrotask(() => agent.onMessage.emit({ type: reply, operationId, generation, ...answer }));
  };
  echoProbes(agent);
  navigation.onConnect.emit(agent);
  navigation.onCommitted.emit({
    tabId: 9,
    frameId: 0,
    url: `${ORIGIN}/app/?run=1`,
    documentId: "doc-1",
  });
  return agent;
}

function harness(agentReply: "restored" | "failed" = "restored") {
  cookies = fakeCookieApi(
    [
      [
        { id: "0", tabIds: [1] },
        { id: "1", tabIds: [9] },
      ],
    ],
    [1],
    [9],
  );
  // The previous Incognito store is gone before the window opens.
  cookies.listings.unshift([{ id: "0", tabIds: [1] }]);
  navigation = fakeNavigationApi();
  barrier = fakeBarrierApi();
  const update = navigation.update;
  navigation.update = async (tabId, url) => {
    await update(tabId, url);
    seen.cookiesAtNavigation = cookies.written.length;
    seen.rulesAtNavigation = barrier.rules.size;
    connectAgent(agentReply);
  };
  navigation.reload = async (tabId) => {
    navigation.reloads.push(tabId);
    seen.rulesAtReload = barrier.rules.size;
    seen.scriptsAtReload = barrier.scripts.size;
    navigation.onCommitted.emit({
      tabId,
      frameId: 0,
      url: `${ORIGIN}/app/?run=1`,
      documentId: "doc-2",
    });
  };
  return {
    cookies,
    stores: memoryStoreMemory(),
    navigation,
    barrier,
    windows: { create: vi.fn(async () => WINDOW), close: vi.fn(async () => {}) },
    hooks: { beforeStep: vi.fn(async () => {}) },
    record: vi.fn(async (operation: WorkspaceOperation) => {
      records.push(operation);
    }),
  } satisfies BootstrapDeps;
}

beforeEach(() => {
  records = [];
  seen = {
    cookiesAtNavigation: -1,
    rulesAtNavigation: -1,
    rulesAtReload: -1,
    scriptsAtReload: -1,
    restorePayload: undefined,
  };
  deps = harness();
});

describe("bootstrapIdentity", () => {
  test("restores cookies and site data behind the barrier, then releases the same tab", async () => {
    const timings = await bootstrapIdentity(URL_, DATA, deps, "op-1");

    expect(cookies.written).toEqual([{ ...DATA.cookies[0], storeId: "1", url: `${ORIGIN}/` }]);
    expect(seen.cookiesAtNavigation).toBe(1);
    expect(seen.rulesAtNavigation).toBe(4);
    expect(seen.restorePayload).toEqual(DATA.site);
    expect(seen.rulesAtReload).toBe(0);
    expect(seen.scriptsAtReload).toBe(0);
    expect(navigation.updates).toEqual([{ tabId: 9, url: URL_ }]);
    expect(navigation.reloads).toEqual([9]);
    expect(timings.map(({ step }) => step)).toEqual(BOOTSTRAP_STEPS);
    expect(timings.every(({ ms }) => ms >= 0)).toBe(true);
  });

  test("opens the window only once Chrome forgot every remembered Incognito store", async () => {
    const events: string[] = [];
    const probe = cookies.probe;
    cookies.probe = async (storeId) => {
      const answer = await probe(storeId);
      events.push(`probe ${storeId} ${answer}`);
      return answer;
    };
    cookies.alive.set("1", [true, true, false]);
    // Chrome lists no Incognito store on any of the three checks.
    cookies.listings.unshift([{ id: "0", tabIds: [1] }], [{ id: "0", tabIds: [1] }]);
    vi.mocked(deps.windows.create).mockImplementation(async () => {
      events.push("create");
      return WINDOW;
    });
    await bootstrapIdentity(URL_, DATA, { ...deps, stores: memoryStoreMemory(["1"]) }, "op-1");
    expect(events).toEqual(["probe 1 true", "probe 1 true", "probe 1 false", "create"]);
  });

  test("remembers the new window's Incognito store, so the next start can wait for it", async () => {
    const memory = memoryStoreMemory();
    await bootstrapIdentity(URL_, DATA, { ...deps, stores: memory }, "op-1");
    expect(memory.ids).toEqual(["1"]);
  });

  test("runs the test hook before each step and records each step, then done", async () => {
    await bootstrapIdentity(URL_, DATA, deps, "op-1");
    expect(vi.mocked(deps.hooks.beforeStep).mock.calls.map(([step]) => step)).toEqual(
      BOOTSTRAP_STEPS,
    );
    // The window is recorded as soon as it exists, so a restart can close it.
    const window = ["window running", "window running 5"];
    expect(
      records.map(({ step, status, windowId }) => `${step} ${status} ${windowId ?? ""}`.trim()),
    ).toEqual([
      "store-gone running",
      ...window,
      ...BOOTSTRAP_STEPS.slice(2).map((step) => `${step} running 5`),
      "reload done 5",
    ]);
    expect(records.at(-1)).toMatchObject({
      id: "op-1",
      kind: "start-with-identity",
      generation: 2,
      windowId: 5,
    });
  });

  test("on a failed step, records the failure, closes the window, and removes the barrier", async () => {
    vi.mocked(deps.hooks.beforeStep).mockImplementation(async (step) => {
      if (step === "restore") throw new WorkspaceError("InjectedFailure", "Injected at restore.");
    });
    vi.mocked(deps.windows.close).mockImplementation(async () => {
      expect(records.at(-1)?.status).toBe("failed");
    });
    await expect(bootstrapIdentity(URL_, DATA, deps, "op-1")).rejects.toMatchObject({
      name: "InjectedFailure",
    });
    expect(deps.windows.close).toHaveBeenCalledWith([5]);
    expect(barrier.rules.size).toBe(0);
    expect(barrier.scripts.size).toBe(0);
    expect(navigation.reloads).toEqual([]);
    expect(records.at(-1)).toMatchObject({
      step: "restore",
      status: "failed",
      error: "Injected at restore.",
    });
  });

  test("waits until each step is recorded before running it", async () => {
    let release = () => {};
    vi.mocked(deps.record).mockImplementation(async (operation) => {
      records.push(operation);
      if (operation.step === "window" && operation.windowId === undefined) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    const starting = bootstrapIdentity(URL_, DATA, deps, "op-1");
    await vi.waitFor(() => expect(records.at(-1)?.step).toBe("window"));
    expect(deps.windows.create).not.toHaveBeenCalled();
    release();
    await starting;
    expect(deps.windows.create).toHaveBeenCalledOnce();
  });

  test("cleans up even when the failure cannot be recorded", async () => {
    vi.mocked(deps.hooks.beforeStep).mockImplementation(async (step) => {
      if (step === "restore") throw new WorkspaceError("InjectedFailure", "Injected at restore.");
    });
    vi.mocked(deps.record).mockImplementation(async (operation) => {
      if (operation.status === "failed") throw new Error("Storage is full.");
    });
    await expect(bootstrapIdentity(URL_, DATA, deps, "op-1")).rejects.toMatchObject({
      name: "InjectedFailure",
    });
    expect(deps.windows.close).toHaveBeenCalledWith([5]);
    expect(barrier.rules.size).toBe(0);
  });

  test("fails when the agent cannot restore, and leaves the app unreleased", async () => {
    deps = harness("failed");
    await expect(bootstrapIdentity(URL_, DATA, deps, "op-1")).rejects.toMatchObject({
      name: "RestoreFailed",
    });
    expect(navigation.reloads).toEqual([]);
    expect(barrier.rules.size).toBe(0);
  });

  test("closes nothing when it fails before the window exists", async () => {
    cookies.listings.splice(0, cookies.listings.length, [
      { id: "0", tabIds: [1] },
      { id: "1", tabIds: [] },
    ]);
    const failing = bootstrapIdentity(URL_, DATA, { ...deps, storeBoundMs: 0 }, "op-1");
    await expect(failing).rejects.toMatchObject({ name: "IncognitoNotGone" });
    expect(deps.windows.create).not.toHaveBeenCalled();
    expect(deps.windows.close).not.toHaveBeenCalled();
    expect(records.at(-1)).toMatchObject({ step: "store-gone", status: "failed" });
  });

  test("adds a failed cleanup to the recorded error", async () => {
    vi.mocked(deps.hooks.beforeStep).mockImplementation(async (step) => {
      if (step === "navigate") throw new WorkspaceError("InjectedFailure", "Injected at navigate.");
    });
    vi.mocked(deps.windows.close).mockRejectedValue(
      new WorkspaceError("WindowsNotClosed", "Some Incognito windows are still open."),
    );
    await expect(bootstrapIdentity(URL_, DATA, deps, "op-1")).rejects.toMatchObject({
      name: "InjectedFailure",
    });
    expect(records.at(-1)?.error).toBe(
      "Injected at navigate. Cleanup also failed: Some Incognito windows are still open.",
    );
    expect(barrier.rules.size).toBe(0);
  });
});

import type { WorkspaceOperation } from "@recnrun/domain";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { BOOTSTRAP_STEPS, bootstrapIdentity } from "@/background/workspace/bootstrap";
import type { BootstrapDeps } from "@/background/workspace/bootstrap";
import { WorkspaceError } from "@/background/workspace/errors";
import { DATA, ORIGIN, START, WINDOW, bootstrapHarness } from "./bootstrap-harness";
import type { Seen } from "./bootstrap-harness";
import type { FakeBarrierApi } from "./fake-barrier";
import { memoryStoreMemory } from "./fake-cookies";
import type { FakeCookieApi } from "./fake-cookies";
import type { FakeNavigationApi } from "./fake-navigation";

let cookies: FakeCookieApi;
let navigation: FakeNavigationApi;
let barrier: FakeBarrierApi;
let records: WorkspaceOperation[];
let seen: Seen;
let deps: BootstrapDeps;

function use(harness: ReturnType<typeof bootstrapHarness>) {
  ({ cookies, navigation, barrier, records, seen, deps } = harness);
}

beforeEach(() => {
  use(bootstrapHarness());
});

describe("bootstrapIdentity", () => {
  test("restores cookies and site data behind the barrier, then releases the same tab", async () => {
    const timings = await bootstrapIdentity(START, DATA, deps, "op-1");

    expect(cookies.written).toEqual([{ ...DATA.cookies[0], storeId: "1", url: `${ORIGIN}/` }]);
    expect(seen.cookiesAtNavigation).toBe(1);
    expect(seen.rulesAtNavigation).toBe(5);
    expect(seen.restorePayload).toEqual(DATA.site);
    expect(seen.rulesAtReload).toBe(0);
    expect(seen.scriptsAtReload).toBe(0);
    expect(navigation.updates).toEqual([{ tabId: 9, url: START }]);
    // The barrier's document starts the reload, so the released request is the page's own.
    expect(navigation.reloads).toEqual([{ tabId: 9, documentId: "doc-1" }]);
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
    await bootstrapIdentity(START, DATA, { ...deps, stores: memoryStoreMemory(["1"]) }, "op-1");
    expect(events).toEqual(["probe 1 true", "probe 1 true", "probe 1 false", "create"]);
  });

  test("remembers the new window's Incognito store, so the next start can wait for it", async () => {
    const memory = memoryStoreMemory();
    await bootstrapIdentity(START, DATA, { ...deps, stores: memory }, "op-1");
    expect(memory.ids).toEqual(["1"]);
  });

  test("runs the test hook before each step and records each step, then done", async () => {
    await bootstrapIdentity(START, DATA, deps, "op-1");
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
      "layout done 5",
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
    await expect(bootstrapIdentity(START, DATA, deps, "op-1")).rejects.toMatchObject({
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
    const starting = bootstrapIdentity(START, DATA, deps, "op-1");
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
    await expect(bootstrapIdentity(START, DATA, deps, "op-1")).rejects.toMatchObject({
      name: "InjectedFailure",
    });
    expect(deps.windows.close).toHaveBeenCalledWith([5]);
    expect(barrier.rules.size).toBe(0);
  });

  test("fails when the agent cannot restore, and leaves the app unreleased", async () => {
    use(bootstrapHarness("failed"));
    await expect(bootstrapIdentity(START, DATA, deps, "op-1")).rejects.toMatchObject({
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
    const failing = bootstrapIdentity(START, DATA, { ...deps, storeBoundMs: 0 }, "op-1");
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
    await expect(bootstrapIdentity(START, DATA, deps, "op-1")).rejects.toMatchObject({
      name: "InjectedFailure",
    });
    expect(records.at(-1)?.error).toBe(
      "Injected at navigate. Cleanup also failed: Some Incognito windows are still open.",
    );
    expect(barrier.rules.size).toBe(0);
  });
});

describe("bootstrapIdentity on a redirect off the target", () => {
  test("hands over to another site: its redirect is stripped behind the barrier, then followed", async () => {
    navigation.reload = async (tabId, documentId) => {
      navigation.reloads.push({ tabId, documentId });
      const url = "http://sso.localhost:5192/sso/authorize?run=1";
      navigation.onCommitted.emit({ tabId, frameId: 0, url, documentId: "doc-2" });
    };
    await expect(bootstrapIdentity(START, DATA, deps, "op-1")).resolves.toHaveLength(
      BOOTSTRAP_STEPS.length,
    );
    expect(seen.rulesAtNavigation).toBe(5);
    expect(records.at(-1)).toMatchObject({ step: "layout", status: "done" });
  });
});

describe("bootstrapIdentity with fetched cache entries", () => {
  test("registers the scripts that show restored responses' URLs before the release", async () => {
    const entry = {
      request: { url: `${ORIGIN}/a`, method: "GET", headers: [] },
      response: { status: 200, statusText: "OK", headers: [], body: null, type: "basic" as const },
    };
    const fetched = {
      ...entry,
      response: { ...entry.response, url: `${ORIGIN}/b`, redirected: true },
    };
    const site = { ...DATA.site, caches: [{ name: "pages", entries: [fetched] }] };
    const data = { ...DATA, site };
    await bootstrapIdentity(START, data, deps, "op-1");
    expect(seen.scriptsAtReload).toBe(2);
    expect(await deps.responseUrls.read(WINDOW.generation)).toEqual({
      [ORIGIN]: [[`${ORIGIN}/a`, `${ORIGIN}/b`]],
    });

    use(bootstrapHarness());

    vi.mocked(deps.hooks.beforeStep).mockImplementation(async (step) => {
      if (step === "layout") throw new WorkspaceError("InjectedFailure", "Injected at layout.");
    });
    await expect(bootstrapIdentity(START, data, deps, "op-2")).rejects.toMatchObject({
      name: "InjectedFailure",
    });
    expect(barrier.scripts.size).toBe(0);
  });
});

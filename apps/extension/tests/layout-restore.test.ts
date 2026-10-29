import type { SessionLayout } from "@recnrun/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { chromeLayoutApi, restoreLayout } from "@/background/workspace/layout-restore";
import { fakeBarrierApi } from "./fake-barrier";
import { memoryVisits } from "./fake-helper";
import { fakeLayoutApi } from "./fake-layout";
import { fakeNavigationApi } from "./fake-navigation";
import type { FakeNavigationApi } from "./fake-navigation";
import { echoProbes, fakePort } from "./fake-port";

const APP = "http://app.localhost:5192";
const OTHER = "http://other.localhost:5192";
const OPERATION = { id: "op-1", generation: 4 };
const PRIMARY = { windowId: 5, tabId: 9 };
const COUNTS = {
  localStorage: 0,
  sessionStorage: 1,
  databases: 0,
  records: 0,
  caches: 0,
  cacheEntries: 0,
};

/** Each navigation behind the barrier commits and connects that tab's agent, answering `reply`. */
function agentsAnswer(navigation: FakeNavigationApi, reply: (tabId: number) => object) {
  const restores: { tabId: number; payload: unknown }[] = [];
  navigation.update = async (tabId, url) => {
    navigation.updates.push({ tabId, url });
    const origin = new URL(url).origin;
    const documentId = `doc-${navigation.updates.length}`;
    const agent = echoProbes(fakePort({ tab: { id: tabId }, frameId: 0, documentId, origin }));
    const post = agent.postMessage;
    agent.postMessage = (message: unknown) => {
      post(message);
      const { type, operationId, generation, payload } = message as Record<string, unknown>;
      if (type !== "restore") return;
      restores.push({ tabId, payload });
      const tag = { operationId, generation };
      queueMicrotask(() => agent.onMessage.emit({ ...reply(tabId), ...tag }));
    };
    navigation.onCommitted.emit({ tabId, frameId: 0, url, documentId });
    navigation.onConnect.emit(agent);
  };
  return restores;
}

const LAYOUT: SessionLayout = {
  windows: [
    {
      focused: false,
      tabs: [
        { url: `${APP}/app/`, active: false, sessionStorage: [] },
        {
          url: `${APP}/app/?tab=2`,
          active: true,
          sessionStorage: [{ origin: APP, entries: { tab: "second" } }],
        },
      ],
    },
    {
      focused: true,
      tabs: [
        { url: `${OTHER}/blank`, active: true, sessionStorage: [{ origin: OTHER, entries: {} }] },
        {
          url: `${APP}/app/?tab=4`,
          active: false,
          sessionStorage: [{ origin: OTHER, entries: { step: "2" } }],
        },
      ],
    },
  ],
  primary: { window: 0, tab: 0 },
};

function restoring(
  reply: (tabId: number) => object = () => ({ type: "restored", counts: COUNTS }),
  layout: SessionLayout = LAYOUT,
) {
  const deps = {
    layout: fakeLayoutApi(),
    barrier: fakeBarrierApi(),
    navigation: fakeNavigationApi(),
    visits: memoryVisits(OPERATION.generation),
  };
  const restores = agentsAnswer(deps.navigation, reply);
  const opened: number[] = [];
  const run = { primary: PRIMARY, operation: OPERATION, opened: (id: number) => opened.push(id) };
  return { deps, restores, opened, running: restoreLayout(layout, run, deps) };
}

describe("restoreLayout", () => {
  test("reopens each tab in its place with its own sessionStorage before its page, then focuses", async () => {
    const run = restoring();
    await expect(run.running).resolves.toEqual([]);
    expect(run.deps.layout.calls).toEqual([
      "tab 200 in 5 at 1",
      `navigate 200 ${APP}/app/?tab=2`,
      "activate 200",
      "window 50",
      "tab 201 in 50 at 1",
      `navigate 500 ${OTHER}/blank`,
      "activate 500",
      `navigate 201 ${APP}/app/?tab=4`,
      "focus 50",
    ]);
    expect(run.opened).toEqual([50]);
    // Only a tab that held entries loads behind the barrier, each at its origin's root.
    expect(run.deps.navigation.updates).toEqual([
      { tabId: 200, url: `${APP}/` },
      { tabId: 201, url: `${OTHER}/` },
    ]);
    const session = (entries: object) => ({
      localStorage: {},
      sessionStorage: entries,
      indexedDB: [],
      caches: [],
    });
    expect(run.restores).toEqual([
      { tabId: 200, payload: session({ tab: "second" }) },
      { tabId: 201, payload: session({ step: "2" }) },
    ]);
    expect(run.deps.barrier.rules.size).toBe(0);
    expect(run.deps.barrier.scripts.size).toBe(0);
    // Each reopened tab's origins are its own visits, from its place in the layout.
    expect(await run.deps.visits.tabVisits(OPERATION.generation)).toEqual([
      { tabId: 200, from: { window: 0, tab: 1 }, visits: [{ origin: APP }] },
      { tabId: 201, from: { window: 1, tab: 1 }, visits: [{ origin: OTHER }] },
    ]);
  });

  test("reopens a blank tab and a New Tab page at their places, as they are", async () => {
    const plain = (url: string, active = false) => ({ url, active, sessionStorage: [] });
    const layout: SessionLayout = {
      windows: [
        { focused: false, tabs: [plain(`${APP}/app/`, true), plain("about:blank")] },
        { focused: true, tabs: [plain("chrome://newtab/", true), plain("chrome://newtab/")] },
      ],
      primary: { window: 0, tab: 0 },
    };
    const run = restoring(undefined, layout);
    await expect(run.running).resolves.toEqual([]);
    expect(run.deps.layout.calls).toEqual([
      "tab 200 in 5 at 1",
      "activate 9",
      "new window 50",
      "new tab 201 in 50 at 1",
      "activate 500",
      "focus 50",
    ]);
    expect(run.deps.navigation.updates).toEqual([]);
  });

  test("a tab whose sessionStorage of another origin is not taken still opens, and is named", async () => {
    const run = restoring(() => ({ type: "failed", error: "QuotaExceededError" }));
    const failed = { work: "restore", step: "restore" };
    await expect(run.running).resolves.toEqual([
      // The page's own origin is not carried: the page shows its sessionStorage as it is then.
      {
        origin: APP,
        ...failed,
        reason: "The page could not restore its data (QuotaExceededError).",
        kept: false,
      },
      {
        origin: OTHER,
        work: "restore",
        step: "restore",
        reason: "The page could not restore its data (QuotaExceededError).",
        kept: true,
      },
    ]);
    // Another origin than the page's is carried, so the next capture keeps its last saved copy.
    const tabs = await run.deps.visits.tabVisits(OPERATION.generation);
    expect(tabs.find(({ tabId }) => tabId === 201)?.visits).toEqual([
      { origin: OTHER, carry: true },
    ]);
    expect(run.deps.layout.calls).toContain(`navigate 201 ${APP}/app/?tab=4`);
    expect(run.deps.barrier.rules.size).toBe(0);
  });
});

describe("chromeLayoutApi", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  // The Node projects share a worker, so a spy left on the fake browser would reach other files.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("opens an unfocused blank Incognito window and background blank tabs once they loaded", async () => {
    const create = vi
      .spyOn(fakeBrowser.windows, "create")
      .mockResolvedValue({ id: 3, tabs: [{ id: 30 }] } as never);
    const get = vi
      .spyOn(fakeBrowser.tabs, "get")
      .mockResolvedValue({ status: "complete" } as never);
    await expect(chromeLayoutApi.openWindow(false)).resolves.toEqual({ windowId: 3, tabId: 30 });
    expect(create).toHaveBeenCalledWith({ incognito: true, url: "about:blank", focused: false });
    const tab = vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({ id: 31 } as never);
    await expect(chromeLayoutApi.openTab(3, 1, false)).resolves.toBe(31);
    expect(tab).toHaveBeenCalledWith({ windowId: 3, index: 1, url: "about:blank", active: false });
    expect(get.mock.calls).toEqual([[30], [31]]);
  });

  test("opens Chrome's New Tab page in a window or tab by giving it no address", async () => {
    const create = vi
      .spyOn(fakeBrowser.windows, "create")
      .mockResolvedValue({ id: 3, tabs: [{ id: 30 }] } as never);
    vi.spyOn(fakeBrowser.tabs, "get").mockResolvedValue({ status: "complete" } as never);
    await chromeLayoutApi.openWindow(true);
    expect(create).toHaveBeenCalledWith({ incognito: true, focused: false });
    const tab = vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({ id: 31 } as never);
    await chromeLayoutApi.openTab(3, 2, true);
    expect(tab).toHaveBeenCalledWith({ windowId: 3, index: 2, active: false });
  });

  test("refuses a window or tab Chrome returned without an id", async () => {
    vi.spyOn(fakeBrowser.windows, "create").mockResolvedValueOnce({} as never);
    await expect(chromeLayoutApi.openWindow(false)).rejects.toThrow(
      "Chrome did not open the window.",
    );
    vi.spyOn(fakeBrowser.windows, "create").mockResolvedValueOnce({ id: 3, tabs: [] } as never);
    await expect(chromeLayoutApi.openWindow(false)).rejects.toThrow(
      "Chrome did not open the window.",
    );
    vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValueOnce({} as never);
    await expect(chromeLayoutApi.openTab(3, 0, false)).rejects.toThrow(
      "Chrome did not open the tab.",
    );
  });

  test("navigates, activates, and focuses through tabs and windows updates", async () => {
    const tabs = vi.spyOn(fakeBrowser.tabs, "update").mockResolvedValue({} as never);
    const windows = vi.spyOn(fakeBrowser.windows, "update").mockResolvedValue({} as never);
    await chromeLayoutApi.navigate(7, `${APP}/app/`);
    await chromeLayoutApi.activate(7);
    await chromeLayoutApi.focus(3);
    expect(tabs.mock.calls).toEqual([
      [7, { url: `${APP}/app/` }],
      [7, { active: true }],
    ]);
    expect(windows).toHaveBeenCalledWith(3, { focused: true });
  });
});

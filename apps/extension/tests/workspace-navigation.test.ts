import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  chromeNavigationApi,
  openBehindBarrier,
  reloadAndCommit,
} from "@/background/workspace/navigation";
import { fakeNavigationApi, listenerCount } from "./fake-navigation";
import type { FakeNavigationApi } from "./fake-navigation";
import { fakePort } from "./fake-port";

const TAB = 9;
const ORIGIN = "http://app.localhost:5192";
const TARGET = { tabId: TAB, url: `${ORIGIN}/app/redirect?run=1`, origin: ORIGIN };
const agentOf = (documentId: string, tabId = TAB, frameId = 0) =>
  fakePort({ tab: { id: tabId }, frameId, documentId, origin: ORIGIN });
const commit = (api: FakeNavigationApi, documentId: string, url = `${ORIGIN}/app/?run=1`) =>
  api.onCommitted.emit({ tabId: TAB, frameId: 0, url, documentId });

let api: FakeNavigationApi;

beforeEach(() => {
  api = fakeNavigationApi();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("openBehindBarrier", () => {
  test("navigates the tab and hands over the agent of the committed top document", async () => {
    const opening = openBehindBarrier(api, TARGET, 1_000);
    expect(api.updates).toEqual([{ tabId: TAB, url: TARGET.url }]);
    const agent = agentOf("doc-1");
    // Chrome may deliver the agent's port before the commit.
    api.onConnect.emit(agent);
    commit(api, "doc-1");
    await expect(opening).resolves.toBe(agent);
    expect(agent.disconnected).toBe(false);
    expect(listenerCount(api)).toBe(0);
  });

  test("ends links from other tabs, frames, and documents, and ignores other ports", async () => {
    const opening = openBehindBarrier(api, TARGET, 1_000);
    const otherTab = agentOf("doc-1", 3);
    const subframe = agentOf("doc-1", TAB, 2);
    const stale = agentOf("doc-0");
    const site = { ...agentOf("doc-1"), name: "recnrun-site" };
    for (const port of [otherTab, subframe, stale, site]) api.onConnect.emit(port);
    api.onCommitted.emit({ tabId: TAB, frameId: 0, url: "about:blank", documentId: "blank" });
    commit(api, "doc-1");
    const agent = agentOf("doc-1");
    api.onConnect.emit(agent);
    await expect(opening).resolves.toBe(agent);
    expect([otherTab, subframe, stale].map(({ disconnected }) => disconnected)).toEqual([
      true,
      true,
      true,
    ]);
    expect(site.disconnected).toBe(false);
  });

  test("fails explicitly when the tab commits a document of another origin", async () => {
    const opening = openBehindBarrier(api, TARGET, 1_000);
    const early = agentOf("doc-1");
    api.onConnect.emit(early);
    commit(api, "doc-2", "http://other.localhost:5192/app/");
    await expect(opening).rejects.toMatchObject({ name: "OffOriginNavigation" });
    expect(early.disconnected).toBe(true);
    expect(listenerCount(api)).toBe(0);
  });

  test("fails when the navigation errors, the tab closes, or the update is refused", async () => {
    const failing = openBehindBarrier(api, TARGET, 1_000);
    api.onErrorOccurred.emit({ tabId: TAB, frameId: 1, error: "net::ERR_ABORTED" });
    api.onErrorOccurred.emit({ tabId: TAB, frameId: 0, error: "net::ERR_BLOCKED_BY_CLIENT" });
    await expect(failing).rejects.toMatchObject({ name: "NavigationFailed" });
    await expect(failing).rejects.toThrow("net::ERR_BLOCKED_BY_CLIENT");

    const closing = openBehindBarrier(api, TARGET, 1_000);
    api.onTabRemoved.emit(3);
    api.onTabRemoved.emit(TAB);
    await expect(closing).rejects.toMatchObject({ name: "TabClosed" });

    api.failUpdate = new Error("No tab with id: 9.");
    await expect(openBehindBarrier(api, TARGET, 1_000)).rejects.toMatchObject({
      name: "TabClosed",
    });
    expect(listenerCount(api)).toBe(0);
  });

  test("fails when no agent connects within the bound", async () => {
    vi.useFakeTimers();
    const opening = openBehindBarrier(api, TARGET, 1_000);
    const outcome = expect(opening).rejects.toMatchObject({ name: "AgentNotConnected" });
    commit(api, "doc-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(listenerCount(api)).toBe(0);
  });
});

describe("reloadAndCommit", () => {
  test("reloads the tab and resolves with the new document of the target origin", async () => {
    const reloading = reloadAndCommit(
      api,
      { tabId: TAB, origin: ORIGIN, documentId: "doc-1" },
      1_000,
    );
    expect(api.reloads).toEqual([{ tabId: TAB, documentId: "doc-1" }]);
    commit(api, "doc-1");
    api.onCommitted.emit({ tabId: 3, frameId: 0, url: `${ORIGIN}/`, documentId: "doc-x" });
    commit(api, "doc-2");
    await expect(reloading).resolves.toBe("doc-2");
    expect(listenerCount(api)).toBe(0);
  });

  test("fails when the released document is not the target origin's", async () => {
    const reloading = reloadAndCommit(
      api,
      { tabId: TAB, origin: ORIGIN, documentId: "doc-1" },
      1_000,
    );
    commit(api, "doc-2", "chrome-error://chromewebdata/");
    await expect(reloading).rejects.toMatchObject({ name: "OffOriginNavigation" });
  });
});

describe("chromeNavigationApi", () => {
  test("goes through tabs, webNavigation, and runtime ports", async () => {
    const update = vi.spyOn(fakeBrowser.tabs, "update").mockResolvedValue({} as never);
    const inject = vi.spyOn(fakeBrowser.scripting, "executeScript").mockResolvedValue([] as never);
    await chromeNavigationApi.update(TAB, TARGET.url);
    await chromeNavigationApi.reload(TAB, "doc-1");
    expect(update).toHaveBeenCalledWith(TAB, { url: TARGET.url });
    // The reload starts in the page's document, so Chrome names the page's origin its initiator.
    expect(inject).toHaveBeenCalledWith({
      target: { tabId: TAB, documentIds: ["doc-1"] },
      world: "ISOLATED",
      func: expect.any(Function),
    });
    expect(chromeNavigationApi.onCommitted).toBe(fakeBrowser.webNavigation.onCommitted);
    expect(chromeNavigationApi.onErrorOccurred).toBe(fakeBrowser.webNavigation.onErrorOccurred);
    expect(chromeNavigationApi.onTabRemoved).toBe(fakeBrowser.tabs.onRemoved);
    expect(chromeNavigationApi.onConnect).toBe(fakeBrowser.runtime.onConnect);
  });

  test("the injected function reloads the document it runs in", async () => {
    const inject = vi.spyOn(fakeBrowser.scripting, "executeScript").mockResolvedValue([] as never);
    await chromeNavigationApi.reload(TAB, "doc-1");
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const injection = inject.mock.calls[0]?.[0];
    if (injection === undefined || !("func" in injection)) throw new Error("Nothing injected");
    (injection.func as () => void)();
    vi.unstubAllGlobals();
    expect(reload).toHaveBeenCalledOnce();
  });
});

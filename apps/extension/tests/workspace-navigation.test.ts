import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { chromeAgentPorts } from "@/background/workspace/agent-ports";
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

  test("two tabs opened at once each keep their own agent, and a second agent of one document ends", async () => {
    const other = { ...TARGET, tabId: 4 };
    const opening = openBehindBarrier(api, TARGET, 1_000);
    const openingOther = openBehindBarrier(api, other, 1_000);
    const agent = agentOf("doc-1");
    const twin = agentOf("doc-1");
    const otherAgent = agentOf("doc-4", 4);
    for (const port of [agent, twin, otherAgent]) api.onConnect.emit(port);
    commit(api, "doc-1");
    api.onCommitted.emit({ tabId: 4, frameId: 0, url: `${ORIGIN}/`, documentId: "doc-4" });
    await expect(opening).resolves.toBe(agent);
    await expect(openingOther).resolves.toBe(otherAgent);
    expect([agent, twin, otherAgent].map(({ disconnected }) => disconnected)).toEqual([
      false,
      true,
      false,
    ]);
    expect(listenerCount(api)).toBe(0);
  });

  test("a link another tab's watch takes as it connects stays open, and a later twin of it ends", async () => {
    const other = { ...TARGET, tabId: 4 };
    const opening = openBehindBarrier(api, TARGET, 1_000);
    const openingOther = openBehindBarrier(api, other, 1_000);
    commit(api, "doc-1");
    const agent = agentOf("doc-1");
    api.onConnect.emit(agent);
    await expect(opening).resolves.toBe(agent);
    const twin = agentOf("doc-1");
    api.onConnect.emit(twin);
    api.onCommitted.emit({ tabId: 4, frameId: 0, url: `${ORIGIN}/`, documentId: "doc-4" });
    api.onConnect.emit(agentOf("doc-4", 4));
    await openingOther;
    expect([agent.disconnected, twin.disconnected]).toEqual([false, true]);
  });

  test("a link that arrives once every wait ended is ended at once", async () => {
    const opening = openBehindBarrier(api, TARGET, 1_000);
    commit(api, "doc-1");
    const agent = agentOf("doc-1");
    api.onConnect.emit(agent);
    await expect(opening).resolves.toBe(agent);
    const late = agentOf("doc-5", 5);
    api.onConnect.emit(late);
    expect([agent.disconnected, late.disconnected]).toEqual([false, true]);
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
  const RELEASED = { tabId: TAB, documentId: "doc-1" };

  test("reloads the tab and resolves with the new document of the target origin", async () => {
    const reloading = reloadAndCommit(api, RELEASED, 1_000);
    expect(api.reloads).toEqual([{ tabId: TAB, documentId: "doc-1" }]);
    commit(api, "doc-1");
    api.onCommitted.emit({ tabId: 3, frameId: 0, url: `${ORIGIN}/`, documentId: "doc-x" });
    commit(api, "doc-2");
    await expect(reloading).resolves.toBe("doc-2");
    expect(listenerCount(api)).toBe(0);
  });

  test("fails when the released document is no web page", async () => {
    for (const url of [
      "chrome-error://chromewebdata/",
      "data:text/html,x",
      "ftp://sso.localhost/",
    ]) {
      const reloading = reloadAndCommit(api, RELEASED, 1_000);
      commit(api, "doc-2", url);
      await expect(reloading, url).rejects.toMatchObject({ name: "OffOriginNavigation" });
    }
  });

  test("accepts a document on any http(s) host, as the app handing over to its sign-in", async () => {
    // The restore is done and the barrier gone: where the app's own redirect leads is its business.
    for (const url of ["http://sso.localhost:5192/sso/login?run=1", "https://login.example/"]) {
      const signIn = reloadAndCommit(api, RELEASED, 1_000);
      commit(api, "doc-2", url);
      await expect(signIn, url).resolves.toBe("doc-2");
    }
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
    expect(chromeNavigationApi.onConnect).toBe(chromeAgentPorts);
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

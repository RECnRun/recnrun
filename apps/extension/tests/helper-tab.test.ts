import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  chromeHelperTabApi,
  isHelperTab,
  visitInTab,
  visitOrigins,
} from "@/background/workspace/helper-tab";
import { fakeBarrierApi } from "./fake-barrier";
import type { FakeBarrierApi } from "./fake-barrier";
import { fakeHelperTabs, helperNavigation } from "./fake-helper";
import { fakeNavigationApi, listenerCount } from "./fake-navigation";
import { echoProbes, fakePort } from "./fake-port";
import type { FakeNavigationApi } from "./fake-navigation";

const SSO = "http://sso.localhost:5192";
const CDN = "http://cdn.localhost:5192";
const VISITING = { windowId: 5, operation: { id: "op-1", generation: 2 }, work: "save" as const };

let tabs: ReturnType<typeof fakeHelperTabs>;
let barrier: FakeBarrierApi;
let navigation: FakeNavigationApi;

beforeEach(() => {
  fakeBrowser.reset();
  tabs = fakeHelperTabs();
  barrier = fakeBarrierApi();
  navigation = fakeNavigationApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const deps = () => ({ tabs, barrier, navigation });

describe("visitOrigins", () => {
  test("opens no tab when no other origin was visited", async () => {
    await expect(visitOrigins([], VISITING, deps(), async () => 1)).resolves.toEqual([]);
    expect(tabs.open).not.toHaveBeenCalled();
  });

  test("loads each origin's root in one helper tab behind an anonymous barrier, then closes it", async () => {
    const agents = helperNavigation(navigation, tabs, () => []);
    const seen: { origin: string; rules: number[]; sender: unknown }[] = [];
    const results = await visitOrigins(
      [{ origin: SSO }, { origin: CDN }],
      VISITING,
      deps(),
      async (agent, { origin }) => {
        const rules = [...barrier.rules.values()];
        seen.push({ origin, rules: rules.map(({ id }) => id), sender: agent.sender });
        return origin.length;
      },
    );
    expect(results).toEqual([
      { ok: true, value: SSO.length },
      { ok: true, value: CDN.length },
    ]);
    expect(tabs.opened).toEqual([{ tabId: 100, windowId: 5 }]);
    expect(navigation.updates).toEqual([
      { tabId: 100, url: `${SSO}/` },
      { tabId: 100, url: `${CDN}/` },
    ]);
    // Generation 2's six rules, the anonymous one among them, guard each visit in turn.
    expect(seen.map(({ rules }) => rules)).toEqual([
      [21, 22, 23, 24, 25, 26],
      [21, 22, 23, 24, 25, 26],
    ]);
    expect(seen[1]?.sender).toMatchObject({ tab: { id: 100 }, origin: CDN });
    expect(agents.every(({ disconnected }) => disconnected)).toBe(true);
    expect(tabs.closed).toEqual([100]);
    expect(barrier.rules.size).toBe(0);
    expect(barrier.scripts.size).toBe(0);
    expect(listenerCount(navigation)).toBe(0);
  });

  test("skips an origin whose work fails, by origin and step, and goes on to the next", async () => {
    helperNavigation(navigation, tabs, () => []);
    const outcomes = await visitOrigins(
      [{ origin: CDN }, { origin: SSO }],
      VISITING,
      deps(),
      async (_, { origin }) => {
        if (origin === CDN)
          throw new Error("The page could not capture its data (QuotaExceededError).");
        return 1;
      },
    );
    expect(outcomes).toEqual([
      {
        ok: false,
        origin: CDN,
        step: "save",
        reason: "The page could not capture its data (QuotaExceededError).",
      },
      { ok: true, value: 1 },
    ]);
    expect(tabs.closed).toEqual([100]);
    expect(barrier.rules.size).toBe(0);
    expect(barrier.scripts.size).toBe(0);
  });

  test("an origin whose pages do not load is skipped at the navigate step", async () => {
    navigation.update = async (tabId, url) => {
      navigation.updates.push({ tabId, url });
      navigation.onErrorOccurred.emit({ tabId, frameId: 0, error: "net::ERR_CONNECTION_RESET" });
    };
    const visiting = { ...VISITING, work: "restore" as const };
    const use = vi.fn(async () => 0);
    const outcomes = await visitOrigins([{ origin: SSO, url: `${SSO}/` }], visiting, deps(), use);
    expect(outcomes).toEqual([
      {
        ok: false,
        origin: SSO,
        step: "navigate",
        reason: "The page did not load (net::ERR_CONNECTION_RESET).",
      },
    ]);
    // The last page is the root itself, so it is not loaded twice.
    expect(navigation.updates).toEqual([{ tabId: 100, url: `${SSO}/` }]);
    expect(use).not.toHaveBeenCalled();
    expect(barrier.rules.size).toBe(0);
    expect(tabs.closed).toEqual([100]);
    expect(listenerCount(navigation)).toBe(0);
  });

  test("tries the last page the window showed when the root does not load", async () => {
    helperNavigation(navigation, tabs, () => []);
    const commit = navigation.update;
    navigation.update = async (tabId, url) => {
      if (url !== `${SSO}/`) return commit(tabId, url);
      navigation.updates.push({ tabId, url });
      navigation.onErrorOccurred.emit({ tabId, frameId: 0, error: "net::ERR_EMPTY_RESPONSE" });
    };
    const register = vi.spyOn(barrier, "registerScript");
    const item = { origin: SSO, url: `${SSO}/account` };
    const outcomes = await visitOrigins([item], VISITING, deps(), async (agent) => agent.sender);
    expect(outcomes).toEqual([{ ok: true, value: expect.objectContaining({ origin: SSO }) }]);
    expect(navigation.updates).toEqual([
      { tabId: 100, url: `${SSO}/` },
      { tabId: 100, url: `${SSO}/account` },
    ]);
    // One barrier guards both pages, and it is gone after.
    expect(register).toHaveBeenCalledTimes(1);
    expect(barrier.rules.size).toBe(0);
  });

  test("a work that fails on the root is tried again on the last page", async () => {
    helperNavigation(navigation, tabs, () => []);
    const item = { origin: SSO, url: `${SSO}/account` };
    const use = vi.fn(async () => {
      if (use.mock.calls.length === 1) throw new Error("The page stopped sending its data.");
      return 2;
    });
    const outcomes = await visitOrigins([item], VISITING, deps(), use);
    expect(outcomes).toEqual([{ ok: true, value: 2 }]);
    expect(navigation.updates.map(({ url }) => url)).toEqual([`${SSO}/`, `${SSO}/account`]);
  });

  test("fails at the tab, barrier, and unbarrier steps by name", async () => {
    tabs.open.mockRejectedValueOnce(new Error("No window with id: 5."));
    await expect(visitOrigins([{ origin: SSO }], VISITING, deps(), async () => 0)).rejects.toThrow(
      `Could not save the site data of ${SSO} at its tab step: No window with id: 5.`,
    );

    barrier.registerError = new Error("Chrome refused.");
    await expect(visitOrigins([{ origin: SSO }], VISITING, deps(), async () => 0)).rejects.toThrow(
      `of ${SSO} at its barrier step: Chrome did not register the origin agent.`,
    );
    expect(barrier.rules.size).toBe(0);

    barrier.registerError = undefined;
    helperNavigation(navigation, tabs, () => []);
    barrier.ignoreRemovals = true;
    await expect(visitOrigins([{ origin: SSO }], VISITING, deps(), async () => 0)).rejects.toThrow(
      `of ${SSO} at its unbarrier step: Chrome still lists the barrier after removing it.`,
    );
    expect(tabs.closed).toEqual([100, 101]);
  });
});

describe("visitInTab", () => {
  test("leaves the borrowed tab's barrier pages out of the visits, and a helper tab stays one", async () => {
    navigation.update = async (tabId, url) => {
      navigation.updates.push({ tabId, url });
      const documentId = `doc-${navigation.updates.length}`;
      const sender = { tab: { id: tabId }, frameId: 0, documentId, origin: SSO };
      navigation.onCommitted.emit({ tabId, frameId: 0, url, documentId });
      navigation.onConnect.emit(echoProbes(fakePort(sender)));
    };
    const visiting = { operation: VISITING.operation, work: "save" as const };
    const during = (tabId: number) => async () => isHelperTab(tabId);
    const borrowed = await visitInTab({ tabId: 42, origin: SSO }, visiting, deps(), during(42));
    expect(borrowed).toEqual({ ok: true, value: true });
    expect(isHelperTab(42)).toBe(false);
    const windowId = (await fakeBrowser.windows.create({}))?.id ?? -1;
    const helper = await chromeHelperTabApi.open(windowId);
    await visitInTab({ tabId: helper, origin: SSO }, visiting, deps(), during(helper));
    expect(isHelperTab(helper)).toBe(true);
    await chromeHelperTabApi.close(helper);
  });
});

describe("chromeHelperTabApi", () => {
  test("opens a background blank tab in the window once it loaded, and removes it", async () => {
    const windowId = (await fakeBrowser.windows.create({}))?.id ?? -1;
    const create = vi.spyOn(fakeBrowser.tabs, "create");
    const tabId = await chromeHelperTabApi.open(windowId);
    expect(create).toHaveBeenCalledWith({ windowId, url: "about:blank", active: false });
    expect((await fakeBrowser.tabs.get(tabId)).windowId).toBe(windowId);
    // The visit tracker leaves the helper tab's pages out while it is open.
    expect(isHelperTab(tabId)).toBe(true);
    const remove = vi.spyOn(fakeBrowser.tabs, "remove");
    await chromeHelperTabApi.close(tabId);
    expect(remove).toHaveBeenCalledWith(tabId);
    expect(isHelperTab(tabId)).toBe(false);
  });

  test("refuses a tab Chrome returned without an id", async () => {
    vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({} as never);
    await expect(chromeHelperTabApi.open(1)).rejects.toThrow("Chrome did not open the helper tab.");
  });
});

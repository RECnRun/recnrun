import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { chromeHelperTabApi, visitOrigins } from "@/background/workspace/helper-tab";
import { fakeBarrierApi } from "./fake-barrier";
import type { FakeBarrierApi } from "./fake-barrier";
import { fakeHelperTabs, helperNavigation } from "./fake-helper";
import { fakeNavigationApi, listenerCount } from "./fake-navigation";
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
    expect(results).toEqual([SSO.length, CDN.length]);
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

  test("names the origin and the step that failed, and leaves no barrier or tab behind", async () => {
    helperNavigation(navigation, tabs, () => []);
    const failing = visitOrigins(
      [{ origin: SSO }, { origin: CDN }],
      VISITING,
      deps(),
      async (_, { origin }) => {
        if (origin === CDN)
          throw new Error("The page could not capture its data (QuotaExceededError).");
      },
    );
    await expect(failing).rejects.toMatchObject({
      name: "VisitedOriginFailed",
      message: `Could not save the site data of ${CDN} at its save step: The page could not capture its data (QuotaExceededError).`,
    });
    expect(tabs.closed).toEqual([100]);
    expect(barrier.rules.size).toBe(0);
    expect(barrier.scripts.size).toBe(0);
  });

  test("a page that does not load fails at the navigate step", async () => {
    navigation.update = async (tabId) => {
      navigation.onErrorOccurred.emit({ tabId, frameId: 0, error: "net::ERR_CONNECTION_REFUSED" });
    };
    const visiting = { ...VISITING, work: "restore" as const };
    await expect(
      visitOrigins([{ origin: SSO }], visiting, deps(), async () => 0),
    ).rejects.toMatchObject({
      name: "VisitedOriginFailed",
      message: `Could not restore the site data of ${SSO} at its navigate step: The page did not load (net::ERR_CONNECTION_REFUSED).`,
    });
    expect(barrier.rules.size).toBe(0);
    expect(tabs.closed).toEqual([100]);
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

describe("chromeHelperTabApi", () => {
  test("opens a background blank tab in the window once it loaded, and removes it", async () => {
    const windowId = (await fakeBrowser.windows.create({}))?.id ?? -1;
    const create = vi.spyOn(fakeBrowser.tabs, "create");
    const tabId = await chromeHelperTabApi.open(windowId);
    expect(create).toHaveBeenCalledWith({ windowId, url: "about:blank", active: false });
    expect((await fakeBrowser.tabs.get(tabId)).windowId).toBe(windowId);
    const remove = vi.spyOn(fakeBrowser.tabs, "remove");
    await chromeHelperTabApi.close(tabId);
    expect(remove).toHaveBeenCalledWith(tabId);
  });

  test("refuses a tab Chrome returned without an id", async () => {
    vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({} as never);
    await expect(chromeHelperTabApi.open(1)).rejects.toThrow("Chrome did not open the helper tab.");
  });
});

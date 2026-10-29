import { beforeEach, expect, test, vi } from "vite-plus/test";
import { openPrimary } from "@/background/workspace/primary-read";
import type { MovedTab } from "@/background/workspace/tab-origins";
import { fakeBarrierApi } from "./fake-barrier";
import { fakeNavigationApi, listenerCount } from "./fake-navigation";
import type { FakeNavigationApi } from "./fake-navigation";
import { echoProbes, fakeEvent, fakePort } from "./fake-port";

const APP = "http://app.localhost:5192";
const OPERATION = { id: "op-1", generation: 3 };
const AT = {
  tabId: 7,
  windowId: 1,
  active: true,
  url: `${APP}/app/?x=1`,
  origin: APP,
  place: "window 1, tab 1",
};

let navigation: FakeNavigationApi;
let barrier: ReturnType<typeof fakeBarrierApi>;
let moved: MovedTab[];

beforeEach(() => {
  navigation = fakeNavigationApi();
  barrier = fakeBarrierApi();
  moved = [];
});

/** The tab's page agent, connected on injection into its document. */
function pageApi() {
  const onConnect = fakeEvent<[ReturnType<typeof fakePort>]>();
  const agents: ReturnType<typeof fakePort>[] = [];
  const inject = vi.fn(async (tabId: number, documentId: string) => {
    const agent = echoProbes(fakePort({ tab: { id: tabId }, frameId: 0, documentId, origin: APP }));
    agents.push(agent);
    onConnect.emit(agent);
  });
  return { api: { inject, onConnect }, agents };
}

const deps = (api = pageApi().api) => ({ api, helper: { barrier, navigation } });
const run = () => ({ operation: OPERATION, boundMs: 1_000, moved });

test("reads a loaded tab through its own page's agent and lets it go on release", async () => {
  const { api, agents } = pageApi();
  const access = await openPrimary({ ...AT, documentId: "doc-7" }, run(), deps(api));
  expect(api.inject).toHaveBeenCalledWith(7, "doc-7");
  expect(await access.read(async (port) => port === agents[0])).toBe(true);
  access.release();
  expect(agents[0]?.disconnected).toBe(true);
  expect(navigation.updates).toEqual([]);
  expect(moved).toEqual([]);
});

test("reads an unloaded tab by loading its origin in it behind the barrier, and notes it moved", async () => {
  navigation.update = async (tabId, url) => {
    navigation.updates.push({ tabId, url });
    const documentId = `doc-${navigation.updates.length}`;
    navigation.onCommitted.emit({ tabId, frameId: 0, url, documentId });
    navigation.onConnect.emit(
      echoProbes(fakePort({ tab: { id: tabId }, frameId: 0, documentId, origin: APP })),
    );
  };
  const { api } = pageApi();
  const access = await openPrimary(AT, run(), deps(api));
  expect(await access.read(async () => "read")).toBe("read");
  access.release();
  expect(api.inject).not.toHaveBeenCalled();
  // The barrier loads the origin's root; the page the tab showed comes back with the moved tabs.
  expect(navigation.updates).toEqual([{ tabId: 7, url: `${APP}/` }]);
  expect(moved).toEqual([{ tabId: 7, url: AT.url }]);
  expect(barrier.rules.size).toBe(0);
  expect(listenerCount(navigation)).toBe(0);
});

test("fails the read of an unloaded tab whose origin does not load, naming the step", async () => {
  navigation.failUpdate = new Error("Tab is gone.");
  const access = await openPrimary(AT, run(), deps());
  const failure = access.read(async () => "read");
  await expect(failure).rejects.toMatchObject({ name: "VisitedOriginFailed" });
  await expect(failure).rejects.toThrow(
    `Could not save the site data of ${APP} at its navigate step:`,
  );
  expect(moved).toEqual([{ tabId: 7, url: AT.url }]);
});

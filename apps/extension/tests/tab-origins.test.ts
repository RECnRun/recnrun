import type { SessionLayout } from "@recnrun/domain";
import { expect, test, vi } from "vite-plus/test";
import type { LayoutRead, SessionTab, SessionTabs } from "@/background/workspace/session-tabs";
import { readTabOrigins, returnTabs } from "@/background/workspace/tab-origins";
import type { TabVisits } from "@/ports/visited-origins";
import { fakeBarrierApi } from "./fake-barrier";
import { memoryVisits } from "./fake-helper";
import { fakeNavigationApi } from "./fake-navigation";
import { echoProbes, fakePort } from "./fake-port";

const APP = "http://app.localhost:5192";
const OTHER = "http://other.localhost:5192";
const SSO = "http://sso.localhost:5192";
const OPERATION = { id: "op-1", generation: 4 };
const EMPTY = { databases: 0, records: 0, caches: 0, cacheEntries: 0 };

const tab = (tabId: number, index: number): SessionTab => ({
  tabId,
  windowId: 1,
  active: index === 0,
  url: `${APP}/app/?tab=${index}`,
  origin: APP,
  documentId: `doc-${tabId}`,
  place: `window 1, tab ${index + 1}`,
});

function session(): { found: SessionTabs; read: LayoutRead } {
  const tabs = [tab(10, 0), tab(11, 1)];
  const found = {
    windows: [{ focused: true, tabs }],
    primary: tabs[0] as SessionTab,
    unsupported: [],
    seen: [10, 11, 12],
  };
  const laid = tabs.map(({ url, active }) => ({ url, active, sessionStorage: [] }));
  const layout = { windows: [{ focused: true, tabs: laid }], primary: { window: 0, tab: 0 } };
  return { found, read: { layout, unsupported: [], entries: 0 } };
}

/** Each navigation behind the barrier connects an agent that hands over `held[origin]`, or fails. */
function agentsHold(held: Record<string, Record<string, string> | undefined>) {
  const navigation = fakeNavigationApi();
  navigation.update = async (tabId, url) => {
    navigation.updates.push({ tabId, url });
    const origin = new URL(url).origin;
    const documentId = `nav-${navigation.updates.length}`;
    const agent = echoProbes(fakePort({ tab: { id: tabId }, frameId: 0, documentId, origin }));
    const post = agent.postMessage;
    agent.postMessage = (message: unknown) => {
      post(message);
      const { operationId, generation } = message as Record<string, unknown>;
      const tag = { operationId, generation };
      const entries = held[origin];
      queueMicrotask(() => {
        if (entries === undefined) {
          agent.onMessage.emit({ type: "failed", error: "SecurityError", ...tag });
          return;
        }
        const storage = { localStorage: {}, sessionStorage: entries };
        agent.onMessage.emit({ type: "capture-storage", ...tag, ...storage });
        const counts = { localStorage: 0, sessionStorage: Object.keys(entries).length, ...EMPTY };
        agent.onMessage.emit({ type: "captured", ...tag, counts, cookieNames: [] });
      });
    };
    navigation.onCommitted.emit({ tabId, frameId: 0, url, documentId });
    navigation.onConnect.emit(agent);
  };
  return navigation;
}

const PREVIOUS: SessionLayout = {
  windows: [
    {
      focused: true,
      tabs: [
        { url: `${APP}/app/`, active: true, sessionStorage: [] },
        {
          url: `${APP}/app/?tab=1`,
          active: false,
          sessionStorage: [{ origin: SSO, entries: { state: "kept" } }],
        },
      ],
    },
  ],
  primary: { window: 0, tab: 0 },
};

function reading(tabs: TabVisits[], held: Parameters<typeof agentsHold>[0]) {
  const deps = {
    api: { discard: vi.fn(async (tabId: number) => tabId + 100) },
    barrier: fakeBarrierApi(),
    navigation: agentsHold(held),
    visits: memoryVisits(OPERATION.generation, [], tabs),
  };
  const previous = vi.fn(async () => PREVIOUS);
  const run = { operation: OPERATION, boundMs: 5_000, live: true, previous, moved: [] };
  return { deps, run, ...session() };
}

test("reads each tab's other origins in that tab once it is unloaded, and keeps a carried one as saved", async () => {
  const visited = [{ origin: APP }, { origin: OTHER, url: `${OTHER}/blank` }];
  const carried = {
    tabId: 11,
    from: { window: 0, tab: 1 },
    visits: [{ origin: SSO, carry: true }],
  };
  const { deps, run, found, read } = reading([{ tabId: 10, visits: visited }, carried], {
    [OTHER]: { step: "2" },
  });
  await readTabOrigins(found, read, run, deps);
  expect(read.layout.windows[0]?.tabs.map(({ sessionStorage }) => sessionStorage)).toEqual([
    [{ origin: OTHER, entries: { step: "2" } }],
    [{ origin: SSO, entries: { state: "kept" } }],
  ]);
  expect(read.entries).toBe(1);
  expect(read.unsupported).toEqual([]);
  // Only the tab read live moves, under the id the discard gave it, and the close knows that id.
  expect(deps.api.discard.mock.calls).toEqual([[10]]);
  expect(run.moved).toEqual([{ tabId: 110, url: `${APP}/app/?tab=0` }]);
  expect(found.seen).toEqual([110, 11, 12]);
  expect(deps.navigation.updates).toEqual([{ tabId: 110, url: `${OTHER}/` }]);
  expect(deps.barrier.rules.size).toBe(0);
  expect(deps.barrier.scripts.size).toBe(0);
});

test("an origin the tab does not hand over is named, with the last saved copy kept when there is one", async () => {
  const carried = { tabId: 11, from: { window: 0, tab: 1 }, visits: [{ origin: SSO }] };
  const { deps, run, found, read } = reading([carried], {});
  await readTabOrigins(found, read, run, deps);
  expect(read.layout.windows[0]?.tabs[1]?.sessionStorage).toEqual([
    { origin: SSO, entries: { state: "kept" } },
  ]);
  expect(read.unsupported).toEqual([
    {
      adapter: "tabs",
      item: `window 1, tab 2, ${SSO}`,
      reason: "The page could not capture its data (SecurityError). The last saved copy is kept.",
    },
  ]);
});

test("a tab Chrome does not unload keeps its other origins unread, and is named for each", async () => {
  const { deps, run, found, read } = reading([{ tabId: 10, visits: [{ origin: OTHER }] }], {});
  deps.api.discard.mockRejectedValueOnce(new Error("Cannot discard the tab."));
  await readTabOrigins(found, read, run, deps);
  expect(read.layout.windows[0]?.tabs[0]?.sessionStorage).toEqual([]);
  expect(read.unsupported).toEqual([
    {
      adapter: "tabs",
      item: `window 1, tab 1, ${OTHER}`,
      reason: "Chrome did not unload the tab, so its other origins stayed unread.",
    },
  ]);
  expect(run.moved).toEqual([]);
  expect(found.seen).toEqual([10, 11, 12]);
  expect(run.previous).not.toHaveBeenCalled();
});

test("a capture the windows outlast leaves every tab on its page and keeps the last saved copies", async () => {
  const visits = [{ origin: SSO }, { origin: OTHER }];
  const { deps, run, found, read } = reading([{ tabId: 11, from: { window: 0, tab: 1 }, visits }], {
    [OTHER]: { step: "2" },
  });
  await readTabOrigins(found, read, { ...run, live: false }, deps);
  expect(deps.api.discard).not.toHaveBeenCalled();
  expect(deps.navigation.updates).toEqual([]);
  expect(read.layout.windows[0]?.tabs[1]?.sessionStorage).toEqual([
    { origin: SSO, entries: { state: "kept" } },
  ]);
  const reason = "A tab's other origins are read only when its identity closes, so the page stays.";
  expect(read.unsupported).toEqual([
    {
      adapter: "tabs",
      item: `window 1, tab 2, ${SSO}`,
      reason: `${reason} The last saved copy is kept.`,
    },
    { adapter: "tabs", item: `window 1, tab 2, ${OTHER}`, reason },
  ]);
});

test("leaves a blank or New Tab page where it is, whatever it visited before", async () => {
  const { deps, run, found, read } = reading([{ tabId: 12, visits: [{ origin: OTHER }] }], {
    [OTHER]: { step: "2" },
  });
  const blank = {
    tabId: 12,
    windowId: 1,
    active: false,
    url: "about:blank" as const,
    place: "window 1, tab 3",
  };
  found.windows[0]?.tabs.push(blank);
  read.layout.windows[0]?.tabs.push({ url: "about:blank", active: false, sessionStorage: [] });
  await readTabOrigins(found, read, run, deps);
  expect(deps.api.discard).not.toHaveBeenCalled();
  expect(read.layout.windows[0]?.tabs[2]?.sessionStorage).toEqual([]);
  expect(read.unsupported).toEqual([]);
});

test("brings each moved tab back to its page, past one that cannot load it", async () => {
  const navigate = vi.fn(async (tabId: number, _url: string) => {
    if (tabId === 1) throw new Error("No tab with id: 1.");
  });
  const moved = [
    { tabId: 1, url: `${APP}/app/` },
    { tabId: 2, url: `${OTHER}/blank` },
  ];
  await returnTabs({ navigate }, moved);
  expect(navigate.mock.calls).toEqual([
    [1, `${APP}/app/`],
    [2, `${OTHER}/blank`],
  ]);
});

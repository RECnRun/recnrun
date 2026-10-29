import type { IdentityData, WorkspaceOperation } from "@recnrun/domain";
import { vi } from "vite-plus/test";
import type { BootstrapDeps, HookStep } from "@/background/workspace/bootstrap";
import { fakeBarrierApi } from "./fake-barrier";
import { fakeCookieApi, memoryStoreMemory } from "./fake-cookies";
import { fakeHelperTabs, memoryResponseUrls, memoryVisits } from "./fake-helper";
import { fakeLayoutApi } from "./fake-layout";
import { fakeNavigationApi } from "./fake-navigation";
import type { FakeNavigationApi } from "./fake-navigation";
import { echoProbes, fakePort } from "./fake-port";

export const ORIGIN = "http://app.localhost:5192";
export const START = `${ORIGIN}/app/redirect?run=1`;
export const WINDOW = { generation: 2, windowId: 5, tabId: 9, status: "active" as const };
export const DATA: IdentityData = {
  cookies: [{ name: "sid", value: "s", path: "/", secure: false, httpOnly: true, sameSite: "lax" }],
  site: { localStorage: { theme: "dark" }, sessionStorage: {}, indexedDB: [], caches: [] },
  origins: [],
};
export const COUNTS = {
  localStorage: 1,
  sessionStorage: 0,
  databases: 0,
  records: 0,
  caches: 0,
  cacheEntries: 0,
};

/** What the managed tab saw when it navigated and reloaded. */
export interface Seen {
  cookiesAtNavigation: number;
  rulesAtNavigation: number;
  rulesAtReload: number;
  scriptsAtReload: number;
  restorePayload: unknown;
}

type Reply = "restored" | "failed";

/** The origin agent's port: connects on navigation, echoes the probe, and answers the restore. */
function connectAgent(navigation: FakeNavigationApi, seen: Seen, reply: Reply) {
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

/** A bootstrap over fakes whose managed tab connects an agent answering `agentReply`. */
export function bootstrapHarness(agentReply: Reply = "restored") {
  const records: WorkspaceOperation[] = [];
  const seen: Seen = {
    cookiesAtNavigation: -1,
    rulesAtNavigation: -1,
    rulesAtReload: -1,
    scriptsAtReload: -1,
    restorePayload: undefined,
  };
  const cookies = fakeCookieApi(
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
  const navigation = fakeNavigationApi();
  const barrier = fakeBarrierApi();
  const update = navigation.update;
  navigation.update = async (tabId, url) => {
    await update(tabId, url);
    // Only the managed tab loads the app; a helper tab answers through its own agents.
    if (tabId !== WINDOW.tabId) return;
    seen.cookiesAtNavigation = cookies.written.length;
    seen.rulesAtNavigation = barrier.rules.size;
    connectAgent(navigation, seen, agentReply);
  };
  navigation.reload = async (tabId, documentId) => {
    navigation.reloads.push({ tabId, documentId });
    seen.rulesAtReload = barrier.rules.size;
    seen.scriptsAtReload = barrier.scripts.size;
    navigation.onCommitted.emit({
      tabId,
      frameId: 0,
      url: `${ORIGIN}/app/?run=1`,
      documentId: "doc-2",
    });
  };
  const deps = {
    cookies,
    stores: memoryStoreMemory(),
    navigation,
    barrier,
    helperTabs: fakeHelperTabs(),
    layout: fakeLayoutApi(),
    visits: memoryVisits(),
    responseUrls: memoryResponseUrls(),
    windows: { create: vi.fn(async () => WINDOW), close: vi.fn(async () => {}) },
    hooks: { beforeStep: vi.fn(async (_step: HookStep) => {}) },
    record: vi.fn(async (operation: WorkspaceOperation) => {
      records.push(operation);
    }),
  } satisfies BootstrapDeps;
  return { deps, records, seen, cookies, navigation, barrier };
}

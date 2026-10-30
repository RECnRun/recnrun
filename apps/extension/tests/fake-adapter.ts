import type { BrowserAdapter, TabInfo } from "@/background/browser-adapter";

export const NO_GROUP = -1;

export interface FakeBrowser extends BrowserAdapter {
  tabs: TabInfo[];
  granted: Set<string>;
  /** Patterns the fake recorder script is registered for, or undefined when unregistered. */
  registered: string[] | undefined;
  injected: number[];
  groupTitles: Map<number, string>;
  /** Whether `permissions.request` is accepted; the fake stands in for the person. */
  accepts: boolean;
}

export function tab(partial: Partial<TabInfo> & { id: number }): TabInfo {
  return {
    url: "http://localhost:4300/login",
    groupId: NO_GROUP,
    windowId: 1,
    loaded: true,
    ...partial,
  };
}

export function createFakeBrowser(tabs: TabInfo[], granted: string[] = []): FakeBrowser {
  let nextGroupId = 100;
  let nextTabId = 1000;
  const fake: FakeBrowser = {
    tabs,
    granted: new Set(granted),
    registered: undefined,
    injected: [],
    groupTitles: new Map(),
    accepts: true,
    activeTab: async () => fake.tabs[0],
    groupTabs: async (groupId) => fake.tabs.filter((candidate) => candidate.groupId === groupId),
    createTab: async (url, windowId) => {
      const created = tab({ id: nextTabId++, url, windowId, loaded: false });
      fake.tabs.push(created);
      return created;
    },
    addToGroup: async (tabIds, groupId = nextGroupId++) => {
      for (const candidate of fake.tabs)
        if (tabIds.includes(candidate.id)) candidate.groupId = groupId;
      return groupId;
    },
    nameGroup: async (groupId, title) => {
      fake.groupTitles.set(groupId, title);
    },
    hasOrigin: async (pattern) => fake.granted.has(pattern),
    requestOrigins: async (patterns) => {
      if (fake.accepts) for (const pattern of patterns) fake.granted.add(pattern);
      return fake.accepts;
    },
    grantedOrigins: async () => [...fake.granted],
    registerRecorder: async (matches) => {
      fake.registered = matches.length > 0 ? matches : undefined;
    },
    unregisterRecorder: async () => {
      fake.registered = undefined;
    },
    injectRecorder: async (tabId) => {
      fake.injected.push(tabId);
    },
  };
  return fake;
}

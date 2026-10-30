import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";

/** The part of a tab the controller reasons about. */
export interface TabInfo {
  id: number;
  url?: string;
  groupId: number;
  windowId: number;
  loaded: boolean;
}

/** The browser calls the controller needs; `fakeBrowser` lacks most of them, so tests fake this. */
export interface BrowserAdapter {
  activeTab(): Promise<TabInfo | undefined>;
  groupTabs(groupId: number): Promise<TabInfo[]>;
  createTab(url: string, windowId: number): Promise<TabInfo>;
  /** Adds the tabs to the group, or to a new group when none is given; returns the group id. */
  addToGroup(tabIds: number[], groupId?: number): Promise<number>;
  nameGroup(groupId: number, title: string): Promise<void>;
  hasOrigin(pattern: string): Promise<boolean>;
  requestOrigins(patterns: string[]): Promise<boolean>;
  grantedOrigins(): Promise<string[]>;
  registerRecorder(matches: string[]): Promise<void>;
  unregisterRecorder(): Promise<void>;
  injectRecorder(tabId: number): Promise<void>;
}

export const NO_GROUP = -1;
const RECORDER_SCRIPT = "recorder";
const RECORDER_FILE = "/recorder.js";

/** The fields of `tabs.Tab` the controller reads; message senders carry the same subset. */
export type TabLike = Pick<Browser.tabs.Tab, "id" | "url" | "groupId" | "windowId" | "status">;

export function toTabInfo(tab: TabLike): TabInfo | undefined {
  if (tab.id === undefined) return undefined;
  return {
    id: tab.id,
    url: tab.url,
    groupId: tab.groupId ?? NO_GROUP,
    windowId: tab.windowId,
    loaded: tab.status === "complete",
  };
}

function defined<T>(values: (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

async function registeredRecorder(): Promise<boolean> {
  const scripts = await browser.scripting.getRegisteredContentScripts({ ids: [RECORDER_SCRIPT] });
  return scripts.length > 0;
}

export function createBrowserAdapter(): BrowserAdapter {
  return {
    activeTab: async () => {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      return tab && toTabInfo(tab);
    },
    groupTabs: async (groupId) => defined((await browser.tabs.query({ groupId })).map(toTabInfo)),
    createTab: async (url, windowId) => {
      const tab = toTabInfo(await browser.tabs.create({ url, windowId }));
      if (!tab) throw new Error(`Could not open ${url}.`);
      return tab;
    },
    addToGroup: ([first, ...rest], groupId) => {
      if (first === undefined) throw new Error("No tab to group.");
      const tabIds: [number, ...number[]] = [first, ...rest];
      return browser.tabs.group(groupId === undefined ? { tabIds } : { tabIds, groupId });
    },
    nameGroup: async (groupId, title) => {
      await browser.tabGroups.update(groupId, { title });
    },
    hasOrigin: (pattern) => browser.permissions.contains({ origins: [pattern] }),
    requestOrigins: (origins) => browser.permissions.request({ origins }),
    grantedOrigins: async () => (await browser.permissions.getAll()).origins ?? [],
    registerRecorder: async (matches) => {
      const registered = await registeredRecorder();
      if (matches.length === 0) {
        if (registered)
          await browser.scripting.unregisterContentScripts({ ids: [RECORDER_SCRIPT] });
        return;
      }
      const script: Browser.scripting.RegisteredContentScript = {
        id: RECORDER_SCRIPT,
        js: [RECORDER_FILE],
        matches,
        runAt: "document_idle",
      };
      await (registered
        ? browser.scripting.updateContentScripts([script])
        : browser.scripting.registerContentScripts([script]));
    },
    unregisterRecorder: async () => {
      if (await registeredRecorder()) {
        await browser.scripting.unregisterContentScripts({ ids: [RECORDER_SCRIPT] });
      }
    },
    injectRecorder: async (tabId) => {
      await browser.scripting.executeScript({ target: { tabId }, files: [RECORDER_FILE] });
    },
  };
}

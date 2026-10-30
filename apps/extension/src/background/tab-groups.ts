import type { BrowserAdapter, TabInfo } from "./browser-adapter.ts";
import { NO_GROUP } from "./browser-adapter.ts";
import { originOf, originPattern } from "./origin-patterns.ts";
const GROUP_TITLE = "RECnRun";

/** Who asks: the sender's tab, and the dashboard origin when the request came from a page. */
export interface Caller {
  tab?: TabInfo;
  dashboardOrigin?: string;
}

/** The tab a request is about: the sender's tab, or the active tab for the popup. */
export async function resolveTab(browser: BrowserAdapter, caller: Caller): Promise<TabInfo> {
  const tab = caller.tab ?? (await browser.activeTab());
  if (!tab) throw new Error("No active tab to record.");
  return tab;
}

/** The caller's tab group, created and named when the tab is still ungrouped. */
export async function ensureGroup(browser: BrowserAdapter, tab: TabInfo): Promise<number> {
  if (tab.groupId !== NO_GROUP) return tab.groupId;
  const groupId = await browser.addToGroup([tab.id]);
  await browser.nameGroup(groupId, GROUP_TITLE);
  return groupId;
}

export async function tabsOf(browser: BrowserAdapter, tab: TabInfo): Promise<TabInfo[]> {
  return tab.groupId === NO_GROUP ? [tab] : browser.groupTabs(tab.groupId);
}

/** Tabs the recorder should run in: the dashboard's own tab is left out. */
export function recordableTabs(tabs: TabInfo[], dashboardOrigin: string | undefined): TabInfo[] {
  return tabs.filter(
    (tab) => originPattern(tab.url) !== undefined && originOf(tab.url) !== dashboardOrigin,
  );
}

/** Host permission patterns the tabs (and an extra URL) need that the user has not granted yet. */
export async function missingOrigins(
  browser: BrowserAdapter,
  tabs: TabInfo[],
  dashboardOrigin: string | undefined,
  extraUrl?: string,
): Promise<string[]> {
  const urls = [...recordableTabs(tabs, dashboardOrigin).map((tab) => tab.url), extraUrl];
  const patterns = [...new Set(urls.map(originPattern))].filter(
    (pattern): pattern is string => pattern !== undefined,
  );
  const granted = await Promise.all(patterns.map((pattern) => browser.hasOrigin(pattern)));
  return patterns.filter((_, index) => !granted[index]);
}

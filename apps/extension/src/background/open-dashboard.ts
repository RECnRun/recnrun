import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";

type Tab = Browser.tabs.Tab;

const OPEN_DASHBOARD = "open-dashboard";
const OPEN_RECNRUN = "open-recnrun";
// browser.tabs.SPLIT_VIEW_ID_NONE, which Chrome before 140 and fakeBrowser lack.
const SPLIT_VIEW_ID_NONE = -1;

// No documentUrlPatterns: in a frame Chrome matches the frame's URL, which hides the item over
// the dashboard frame on recnrun.com. Chrome never shows extension items on chrome:// pages.
export const PAGE_MENU_ITEM = {
  id: OPEN_RECNRUN,
  title: "Open RECnRun",
  contexts: ["page", "frame"],
} satisfies Browser.contextMenus.CreateProperties;

/** Where a trigger from a tab opens the dashboard. */
export type Placement =
  | { kind: "tab" }
  | { kind: "split"; tab: Tab; workspace?: string }
  | { kind: "partner"; splitViewId: number };

/** Focuses the dashboard tab if one is open, otherwise opens it in a new tab. */
export async function openDashboard(url: string): Promise<void> {
  // The extension sees its own pages' URLs without the "tabs" permission; queries ignore the hash.
  const [existing] = await browser.tabs.query({ url });
  if (existing?.id === undefined) {
    await browser.tabs.create({ url });
    return;
  }
  await browser.tabs.update(existing.id, { active: true });
  await browser.windows.update(existing.windowId, { focused: true });
}

/** Splits a tab with the dashboard, of its workspace for a web page; else keeps the dedicated tab. */
export function placeDashboard(tab: Tab | undefined, splitSupported: boolean): Placement {
  if (!splitSupported || tab?.id === undefined) return { kind: "tab" };
  const splitViewId = tab.splitViewId ?? SPLIT_VIEW_ID_NONE;
  if (splitViewId !== SPLIT_VIEW_ID_NONE) return { kind: "partner", splitViewId };
  // activeTab reveals web pages' URLs only: a new tab, about:blank, and browser pages stay hidden.
  if (tab.url === undefined) return { kind: "split", tab };
  const { protocol, origin } = new URL(tab.url);
  if (protocol !== "http:" && protocol !== "https:") return { kind: "tab" };
  return { kind: "split", tab, workspace: origin };
}

async function openNextTo(tab: Tab, dashboardUrl: string, workspace?: string): Promise<void> {
  const url = workspace ? `${dashboardUrl}?${new URLSearchParams({ workspace })}` : dashboardUrl;
  try {
    await browser.tabs.create({
      url,
      splitWithTabId: tab.id,
      windowId: tab.windowId,
      index: tab.index + 1,
    });
  } catch {
    // Split View can still be off, for example through a flag or an enterprise policy.
    await openDashboard(dashboardUrl);
  }
}

async function focusPartner(splitViewId: number, dashboardUrl: string): Promise<void> {
  const tabs = await browser.tabs.query({ splitViewId });
  const partner = tabs.find((each) => each.url?.startsWith(dashboardUrl));
  if (partner?.id === undefined) return openDashboard(dashboardUrl);
  await browser.tabs.update(partner.id, { active: true });
}

/** Opens the dashboard for the tab a trigger came from. */
export async function openDashboardFrom(
  tab: Tab | undefined,
  dashboardUrl: string,
  splitSupported = "createSplit" in browser.tabs,
): Promise<void> {
  const placement = placeDashboard(tab, splitSupported);
  switch (placement.kind) {
    case "tab":
      return openDashboard(dashboardUrl);
    case "split":
      return openNextTo(placement.tab, dashboardUrl, placement.workspace);
    case "partner":
      return focusPartner(placement.splitViewId, dashboardUrl);
  }
}

/** Opens the dashboard from the toolbar icon, the context menus, and the keyboard command. */
export function registerDashboardTriggers(): (tab?: Tab) => Promise<void> {
  const open = (tab?: Tab) => openDashboardFrom(tab, browser.runtime.getURL("/dashboard.html"));
  browser.action.onClicked.addListener((tab) => void open(tab));
  browser.commands.onCommand.addListener((command, tab) => {
    if (command === OPEN_DASHBOARD) void open(tab);
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === OPEN_DASHBOARD || info.menuItemId === OPEN_RECNRUN) void open(tab);
  });
  // Menu items persist across service worker restarts, so create them once per install or update.
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: OPEN_DASHBOARD, title: "Dashboard", contexts: ["action"] });
    browser.contextMenus.create(PAGE_MENU_ITEM);
  });
  return open;
}

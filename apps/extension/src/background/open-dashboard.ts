import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { showWorkspaceMessage, workspaceSearch } from "@/messaging/dashboard-protocol";
import { isHeld, PANEL_LOCK } from "@/messaging/view-locks";

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

type OpenTab = Tab & { id: number };

const hasId = (tab: Tab | undefined): tab is OpenTab => tab?.id !== undefined;

/** Where a trigger from a tab opens the dashboard. */
export type Placement =
  | { kind: "tab" }
  | { kind: "split"; tab: OpenTab; workspace?: string }
  | { kind: "partner"; splitViewId: number };

/** The one dashboard tab; the extension sees its own pages' URLs without the "tabs" permission. */
async function findDashboard(dashboardUrl: string): Promise<OpenTab | undefined> {
  const tabs = await browser.tabs.query({});
  return tabs.filter(hasId).find((each) => (each.url || each.pendingUrl)?.startsWith(dashboardUrl));
}

async function focus(tab: OpenTab): Promise<void> {
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
}

/** Focuses the dashboard tab if one is open, otherwise opens it in a new tab. */
export async function openDashboard(url: string): Promise<void> {
  const existing = await findDashboard(url);
  if (existing) return focus(existing);
  await browser.tabs.create({ url });
}

/** Splits a tab with the dashboard, of its workspace for a web page; else keeps the dedicated tab. */
export function placeDashboard(tab: Tab | undefined, splitSupported: boolean): Placement {
  if (!splitSupported || !hasId(tab)) return { kind: "tab" };
  const splitViewId = tab.splitViewId ?? SPLIT_VIEW_ID_NONE;
  if (splitViewId !== SPLIT_VIEW_ID_NONE) return { kind: "partner", splitViewId };
  // activeTab reveals web pages' URLs only; development builds, with "tabs", see every address.
  if (tab.url === undefined) return { kind: "split", tab };
  const { protocol, origin } = new URL(tab.url);
  // The dashboard and other extension pages keep the dedicated tab.
  if (protocol === "chrome-extension:") return { kind: "tab" };
  const web = protocol === "http:" || protocol === "https:";
  return web ? { kind: "split", tab, workspace: origin } : { kind: "split", tab };
}

async function openNextTo(tab: Tab, dashboardUrl: string, workspace?: string): Promise<void> {
  try {
    await browser.tabs.create({
      url: dashboardUrl + workspaceSearch(workspace),
      splitWithTabId: tab.id,
      windowId: tab.windowId,
      index: tab.index + 1,
    });
  } catch {
    // Split View can still be off, for example through a flag or an enterprise policy.
    await openDashboard(dashboardUrl);
  }
}

/** Moves the open dashboard beside the page without reloading it, so its PiP panel stays open. */
async function moveNextTo(dashboard: OpenTab, tab: OpenTab, workspace?: string): Promise<void> {
  try {
    const splitViewId = dashboard.splitViewId ?? SPLIT_VIEW_ID_NONE;
    if (splitViewId !== SPLIT_VIEW_ID_NONE) await browser.tabs.unsplit(splitViewId);
    // Moving the dashboard from before the page in its window shifts the page left by one.
    const before = dashboard.windowId === tab.windowId && dashboard.index < tab.index;
    const index = before ? tab.index : tab.index + 1;
    await browser.tabs.move(dashboard.id, { windowId: tab.windowId, index });
    await browser.tabs.createSplit([tab.id, dashboard.id]);
    await browser.runtime.sendMessage(showWorkspaceMessage(dashboard.id, workspace));
  } catch {
    // The page may have closed, or the dashboard may not listen yet; it is still focused below.
  }
  await focus({ ...dashboard, windowId: tab.windowId });
}

async function splitWith(tab: OpenTab, dashboardUrl: string, workspace?: string): Promise<void> {
  const existing = await findDashboard(dashboardUrl);
  if (existing) return moveNextTo(existing, tab, workspace);
  return openNextTo(tab, dashboardUrl, workspace);
}

async function focusPartner(splitViewId: number, dashboardUrl: string): Promise<void> {
  const tabs = await browser.tabs.query({ splitViewId });
  const partner = tabs.filter(hasId).find((each) => each.url?.startsWith(dashboardUrl));
  if (partner === undefined) return openDashboard(dashboardUrl);
  await browser.tabs.update(partner.id, { active: true });
}

/** Opens the one dashboard for the tab a trigger came from, moving it there when it is open. */
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
      return splitWith(placement.tab, dashboardUrl, placement.workspace);
    case "partner":
      return focusPartner(placement.splitViewId, dashboardUrl);
  }
}

/** Opens the dashboard for a trigger, which does nothing while a PiP recording panel floats. */
export async function openForTrigger(
  tab: Tab | undefined,
  dashboardUrl: string,
  panelOpen: () => Promise<boolean>,
): Promise<void> {
  // Moving or showing the dashboard would bring back what the floating panel keeps out of the way.
  if (await panelOpen()) return;
  return openDashboardFrom(tab, dashboardUrl);
}

/** Opens the dashboard from the toolbar icon, the context menus, and the keyboard command. */
export function registerDashboardTriggers(): (tab?: Tab) => Promise<void> {
  const open = (tab?: Tab) =>
    openForTrigger(tab, browser.runtime.getURL("/dashboard.html"), () => isHeld(PANEL_LOCK));
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

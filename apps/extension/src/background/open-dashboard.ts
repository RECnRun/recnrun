import { browser } from "wxt/browser";

const OPEN_DASHBOARD = "open-dashboard";

/** "reuse" focuses an open dashboard; the others are the omnibox's Enter dispositions. */
export type DashboardDisposition = "reuse" | "currentTab" | "newForegroundTab" | "newBackgroundTab";

interface OpenDashboardOptions {
  route?: string;
  disposition?: DashboardDisposition;
}

/** Focuses an open dashboard tab, deep-linking it when asked; false when none is open. */
async function focusExisting(base: string, url: string): Promise<boolean> {
  // The extension sees its own pages' URLs without the "tabs" permission; fragments are ignored.
  const [existing] = await browser.tabs.query({ url: base });
  if (existing?.id === undefined) return false;
  await browser.tabs.update(existing.id, url === base ? { active: true } : { active: true, url });
  await browser.windows.update(existing.windowId, { focused: true });
  return true;
}

/**
 * Focuses the dashboard tab if one is open, otherwise opens it. A route deep-links it
 * (dashboard.html#<route>). Only explicit new-tab dispositions open a second dashboard.
 */
export async function openDashboard({
  route = "",
  disposition = "reuse",
}: OpenDashboardOptions = {}): Promise<void> {
  const base = browser.runtime.getURL("/dashboard.html");
  const url = route === "" ? base : `${base}#${route}`;
  if (disposition === "newForegroundTab" || disposition === "newBackgroundTab") {
    await browser.tabs.create({ url, active: disposition === "newForegroundTab" });
    return;
  }
  if (await focusExisting(base, url)) return;
  // From the omnibox, Enter navigates the tab the user typed in, like any address.
  if (disposition === "currentTab") await browser.tabs.update({ url });
  else await browser.tabs.create({ url });
}

/** Opens the dashboard from the toolbar icon, its context menu, and the keyboard command. */
export function registerDashboardTriggers(): void {
  const open = () => void openDashboard();
  browser.action.onClicked.addListener(open);
  browser.commands.onCommand.addListener((command) => {
    if (command === OPEN_DASHBOARD) open();
  });
  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === OPEN_DASHBOARD) open();
  });
  // Menu items persist across service worker restarts, so create them once per install or update.
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: OPEN_DASHBOARD,
      title: "Open dashboard",
      contexts: ["action"],
    });
  });
}

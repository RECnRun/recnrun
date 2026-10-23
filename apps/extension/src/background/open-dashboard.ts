import { browser } from "wxt/browser";

const OPEN_DASHBOARD = "open-dashboard";

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

/** Opens the dashboard from the toolbar icon, its context menu, and the keyboard command. */
export function registerDashboardTriggers(): () => Promise<void> {
  const open = () => openDashboard(browser.runtime.getURL("/dashboard.html"));
  browser.action.onClicked.addListener(() => void open());
  browser.commands.onCommand.addListener((command) => {
    if (command === OPEN_DASHBOARD) void open();
  });
  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === OPEN_DASHBOARD) void open();
  });
  // Menu items persist across service worker restarts, so create them once per install or update.
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: OPEN_DASHBOARD, title: "Dashboard", contexts: ["action"] });
  });
  return open;
}

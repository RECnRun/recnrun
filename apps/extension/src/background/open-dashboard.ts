import { browser } from "wxt/browser";

const OPEN_DASHBOARD = "open-dashboard";

/** Focuses the dashboard tab if one is open, otherwise opens it in a new tab. */
export async function openDashboard(): Promise<void> {
  const url = browser.runtime.getURL("/dashboard.html");
  // The extension sees its own pages' URLs without the "tabs" permission.
  const [existing] = await browser.tabs.query({ url });
  if (existing?.id === undefined) {
    await browser.tabs.create({ url });
    return;
  }
  await browser.tabs.update(existing.id, { active: true });
  await browser.windows.update(existing.windowId, { focused: true });
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

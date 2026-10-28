import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { BrowserWindow, DashboardBrowser, DashboardTab } from "@/background/dashboard-opener";

// Tabs with no id (devtools) cannot be focused or moved, so they never count.
const toTab = ({ id = -1, windowId, index, url, pendingUrl, incognito }: Browser.tabs.Tab) => ({
  id,
  windowId,
  index,
  url: url || pendingUrl || "",
  incognito,
});

const toWindow = ({ id = -1, incognito }: Browser.windows.Window): BrowserWindow => ({
  id,
  incognito,
});

/** Chrome's tabs and windows for the dashboard opener; `tabs` sees a tab still loading. */
export function chromeDashboardBrowser(url: string): DashboardBrowser {
  return {
    tabs: async () => (await browser.tabs.query({})).map(toTab).filter((tab) => tab.id !== -1),
    windows: async () => (await browser.windows.getAll({ windowTypes: ["normal"] })).map(toWindow),
    // Chrome rejects while the profile has no window yet.
    lastFocused: () =>
      browser.windows
        .getLastFocused({ windowTypes: ["normal"] })
        .then(toWindow)
        .catch(() => undefined),
    open: async (windowId, index) =>
      toTab(await browser.tabs.create({ windowId, index, url, active: true })),
    async openWindow() {
      await browser.windows.create({ url, focused: true });
    },
    async move(tab: DashboardTab, index) {
      await browser.tabs.move(tab.id, { index });
    },
    async focus(tab: DashboardTab) {
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
    },
  };
}

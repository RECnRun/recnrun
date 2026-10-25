import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { BrowserTabs, IncognitoAccess, OpenTab, TabSource } from "@/ports/tabs";

// Kept for views/use-browser-tabs.ts until it imports the port itself.
export type { BrowserTabs, TabSource } from "@/ports/tabs";

function faviconOf(url: string | undefined, incognito: boolean): string | undefined {
  if (url?.startsWith("data:image/")) return url;
  // Fetching it from the extension's normal context would tie the incognito tab to its cookies.
  if (incognito || !url) return undefined;
  return /^https?:/.test(url) ? url : undefined;
}

function toOpenTab(tab: Browser.tabs.Tab): OpenTab[] {
  const { id, windowId, incognito, title, url = "", favIconUrl } = tab;
  if (id === undefined) return [];
  const favicon = faviconOf(favIconUrl, incognito);
  const open = { id, windowId, incognito, title: title || url || "Untitled tab", url };
  return [favicon ? { ...open, favicon } : open];
}

export function toBrowserTabs(windows: readonly Browser.windows.Window[]): BrowserTabs {
  // Chrome lists a Document PiP window as an always-on-top normal window; it is no page to record.
  const browsing = windows.filter((each) => !each.alwaysOnTop);
  const tabs = browsing.flatMap((each) => (each.tabs ?? []).flatMap(toOpenTab));
  const currentId = browsing.find((each) => each.focused)?.tabs?.find((tab) => tab.active)?.id;
  return currentId === undefined ? { tabs } : { tabs, currentId };
}

/**
 * The tab to show as current: the focused window's, or else the last one shown while it stays
 * open, marked as not in focus, since the PiP window or another app may have the focus.
 */
export function currentTab(state: BrowserTabs, lastId?: number) {
  const tab = state.tabs.find((each) => each.id === (state.currentId ?? lastId));
  return { tab, focused: tab !== undefined && state.currentId !== undefined };
}

const TAB_EVENTS = [
  "onCreated",
  "onUpdated",
  "onRemoved",
  "onMoved",
  "onAttached",
  "onActivated",
] as const;

export function browserTabs(): TabSource {
  return {
    // With "Allow in Incognito" on, the extension's normal context also gets incognito windows.
    read: async () =>
      toBrowserTabs(await browser.windows.getAll({ populate: true, windowTypes: ["normal"] })),
    watch: (onChange) => {
      const listener = () => onChange();
      for (const event of TAB_EVENTS) browser.tabs[event].addListener(listener);
      browser.windows.onFocusChanged.addListener(listener);
      return () => {
        for (const event of TAB_EVENTS) browser.tabs[event].removeListener(listener);
        browser.windows.onFocusChanged.removeListener(listener);
      };
    },
  };
}

export const browserIncognito: IncognitoAccess = {
  allowed: () => browser.extension.isAllowedIncognitoAccess(),
  openSettings: async () => {
    await browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
  },
  openWindow: async () => {
    await browser.windows.create({ incognito: true });
  },
};

import type { BrowserTabs, IncognitoAccess, OpenTab, TabSource } from "@/ports/tabs";

export const SHOP: OpenTab = {
  id: 7,
  windowId: 1,
  incognito: false,
  title: "Shop",
  url: "https://shop.example/",
};
export const DOCS: OpenTab = { ...SHOP, id: 8, title: "Docs", url: "https://docs.example/" };
export const PRIVATE: OpenTab = {
  id: 9,
  windowId: 2,
  incognito: true,
  title: "Private",
  url: "https://private.example/",
};

/** Browser tabs the test can change, as the tabs and windows API events would. */
export function fakeTabs(initial: BrowserTabs) {
  let state = initial;
  let reads = 0;
  const listeners = new Set<() => void>();
  const source: TabSource = {
    read: async () => {
      reads += 1;
      return state;
    },
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  const change = (next: BrowserTabs) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return { source, change, reads: () => reads };
}

/** Incognito access as Chrome would grant it, with each details page it opens counted. */
export function fakeIncognito(allowed: boolean) {
  const settings: unknown[] = [];
  let settingsError: Error | undefined;
  const listeners = new Set<() => void>();
  const grants = new Set<() => void>();
  const access: IncognitoAccess = {
    allowed: async () => allowed,
    openSettings: async () => {
      if (settingsError) throw settingsError;
      settings.push(true);
    },
    watchWindows: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    watchSiteAccess: (onChange) => {
      grants.add(onChange);
      return () => grants.delete(onChange);
    },
  };
  /** What Chrome's windows.onCreated and onRemoved would do. */
  const windowsChanged = () => {
    for (const listener of listeners) listener();
  };
  /** What Chrome's permissions.onAdded and onRemoved would do. */
  const siteAccessChanged = () => {
    for (const listener of grants) listener();
  };
  const failSettings = (error: Error) => {
    settingsError = error;
  };
  return { access, settings, windowsChanged, siteAccessChanged, failSettings };
}

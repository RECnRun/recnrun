import type { Page, Worker } from "@playwright/test";

interface LayoutGlobal {
  chrome: {
    windows: {
      getAll(filter: object): Promise<
        {
          id?: number;
          incognito: boolean;
          focused: boolean;
          tabs?: { index: number; url?: string; pendingUrl?: string; active: boolean }[];
        }[]
      >;
    };
  };
}

/** One Incognito window as Chrome lists it: whether it has the focus, and its tabs in order. */
export interface LaidOutWindow {
  id: number;
  focused: boolean;
  tabs: { url: string; active: boolean }[];
}

/** Every Incognito window in Chrome's order, each with its tabs by index. */
export const incognitoLayout = (serviceWorker: Worker): Promise<LaidOutWindow[]> =>
  serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as LayoutGlobal;
    const windows = await chrome.windows.getAll({ populate: true });
    return windows
      .filter(({ incognito }) => incognito)
      .map(({ id = -1, focused, tabs = [] }) => ({
        id,
        focused,
        tabs: [...tabs]
          .sort((one, other) => one.index - other.index)
          .map(({ url, pendingUrl, active }) => ({ url: pendingUrl ?? url ?? "", active })),
      }));
  });

/** The layout without window ids, as two captures of the same session compare. */
export const shapeOf = (layout: readonly LaidOutWindow[]) =>
  layout.map(({ focused, tabs }) => ({ focused, tabs }));

/** Writes `value` into the page's own sessionStorage, which belongs to its tab alone. */
export const writeTabSession = (page: Page, value: string) =>
  page.evaluate((written) => sessionStorage.setItem("tab", written), value);

/** What the page's tab holds in its sessionStorage, or null. */
export const tabSession = (page: Page) => page.evaluate(() => sessionStorage.getItem("tab"));

/** A tab Chrome created, or a top-frame page it committed, timed by the service worker's clock. */
export interface TabEvent {
  kind: "created" | "committed";
  tabId: number;
  url?: string;
  at: number;
}

interface TabEventGlobal {
  chrome: {
    tabs: { onCreated: { addListener(listener: (tab: { id?: number }) => void): void } };
    webNavigation: {
      onCommitted: {
        addListener(
          listener: (details: { tabId: number; frameId: number; url: string }) => void,
        ): void;
      };
    };
  };
  __tabEvents?: TabEvent[];
}

/** Starts timing tab creations and top-frame commits inside the service worker, once. */
export const watchTabEvents = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as TabEventGlobal;
    if (scope.__tabEvents) return;
    const events: TabEvent[] = [];
    scope.__tabEvents = events;
    scope.chrome.tabs.onCreated.addListener(({ id = -1 }) => {
      events.push({ kind: "created", tabId: id, at: Date.now() });
    });
    scope.chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
      if (frameId === 0) events.push({ kind: "committed", tabId, url, at: Date.now() });
    });
  });

/** The tab events seen since `watchTabEvents`, in order. */
export const tabEvents = (serviceWorker: Worker): Promise<TabEvent[]> =>
  serviceWorker.evaluate(() => (globalThis as unknown as TabEventGlobal).__tabEvents ?? []);

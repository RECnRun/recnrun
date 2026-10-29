import type { Worker } from "@playwright/test";

interface ChromeTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
  status?: string;
  active: boolean;
  incognito: boolean;
  windowId: number;
}

interface ChromeWindow {
  id?: number;
  focused: boolean;
  alwaysOnTop: boolean;
  tabs?: ChromeTab[];
}

interface ChromeGlobal {
  /** Window ids in the order Chrome gave them the focus, since `watchFocus` ran. */
  focusOrder?: number[];
  chrome: {
    tabs: {
      query(filter: object): Promise<ChromeTab[]>;
      create(properties: object): Promise<ChromeTab>;
      update(tabId: number, properties: object): Promise<ChromeTab>;
      discard(tabId: number): Promise<ChromeTab | undefined>;
      onUpdated: Record<
        "addListener" | "removeListener",
        (listener: (tabId: number, change: object, tab: ChromeTab) => void) => void
      >;
    };
    windows: {
      create(data: object): Promise<{ id?: number; tabs?: ChromeTab[] }>;
      getAll(filter: object): Promise<ChromeWindow[]>;
      update(windowId: number, properties: object): Promise<unknown>;
      onFocusChanged: { addListener(listener: (windowId: number) => void): void };
    };
    storage: Record<
      "local" | "session",
      { get(key: string | null): Promise<Record<string, unknown>> }
    >;
  };
}

export const sessionUrl = (serviceWorker: Worker) =>
  new URL("session.html", serviceWorker.url()).href;

/** Every tab as Chrome reports it; Playwright emulates focus, so Chrome's tab state is the truth. */
export function chromeTabs(serviceWorker: Worker) {
  return serviceWorker.evaluate(async () => {
    const tabs = await (globalThis as unknown as ChromeGlobal).chrome.tabs.query({});
    return tabs.map(({ id, url = "", active, incognito, windowId }) => ({
      id,
      url,
      active,
      incognito,
      windowId,
    }));
  });
}

/**
 * Records, in the service worker, every window Chrome gives the focus to from now on. Call it
 * before the action whose result `shownTabId` reads.
 */
export function watchFocus(serviceWorker: Worker): Promise<void> {
  return serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as ChromeGlobal;
    if (scope.focusOrder) return;
    const order: number[] = [];
    scope.focusOrder = order;
    scope.chrome.windows.onFocusChanged.addListener((windowId) => order.push(windowId));
  });
}

/**
 * The tab the user sees: the active one of the browsing window that got the focus last. A PiP
 * window (always on top) may take the focus after it, so the focused window alone cannot tell.
 */
export function shownTabId(serviceWorker: Worker): Promise<number | undefined> {
  return serviceWorker.evaluate(async () => {
    const { chrome, focusOrder } = globalThis as unknown as ChromeGlobal;
    if (!focusOrder) throw new Error("Call watchFocus first.");
    const windows = await chrome.windows.getAll({ populate: true });
    const browsing = new Map(
      windows.filter((each) => !each.alwaysOnTop).map((each) => [each.id, each]),
    );
    // Closed windows and Chrome's "no window" id are no longer listed, so they are skipped.
    const last =
      focusOrder.findLast((id) => browsing.has(id)) ??
      windows.find((each) => each.focused && !each.alwaysOnTop)?.id;
    return browsing.get(last)?.tabs?.find((tab) => tab.active)?.id;
  });
}

/** Chrome's id for the tab showing `url`. */
export async function tabIdOf(serviceWorker: Worker, url: string): Promise<number | undefined> {
  const tabs = await chromeTabs(serviceWorker);
  return tabs.find((tab) => tab.url === url)?.id;
}

/** The stored session, or null when none runs. */
export function storedSession(serviceWorker: Worker): Promise<unknown> {
  return serviceWorker.evaluate(async () => {
    const stored = await (globalThis as unknown as ChromeGlobal).chrome.storage.session.get(
      "recording",
    );
    return stored.recording ?? null;
  });
}

/** The tab the stored session records, or null when none runs. */
export async function recordedTabId(serviceWorker: Worker): Promise<number | null> {
  const session = (await storedSession(serviceWorker)) as { tabId?: number } | null;
  return session?.tabId ?? null;
}

/** Opens `url` in a new incognito window, as the user would, and returns its tab's id. */
export function openIncognitoTab(serviceWorker: Worker, url: string): Promise<number | undefined> {
  return serviceWorker.evaluate(async (address) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const created = await chrome.windows.create({ incognito: true, url: address });
    return created.tabs?.[0]?.id;
  }, url);
}

/** Opens `url` in another tab of the window `windowId`, as the user would, and returns its id. */
export function openTabIn(serviceWorker: Worker, windowId: number, url: string): Promise<number> {
  return serviceWorker.evaluate(
    async ([id, address]) => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      const created = await chrome.tabs.create({ windowId: id, url: address, active: false });
      if (created.id === undefined) throw new Error("The tab has no id.");
      return created.id;
    },
    [windowId, url] as const,
  );
}

/** Opens Chrome's New Tab page in the background of the window `windowId`, as Ctrl+T would. */
export function openNewTabIn(serviceWorker: Worker, windowId: number): Promise<number> {
  return serviceWorker.evaluate(async (id) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const created = await chrome.tabs.create({ windowId: id, active: false });
    if (created.id === undefined) throw new Error("The tab has no id.");
    return created.id;
  }, windowId);
}

/** Activates the tab and focuses its window, as a click on it would. */
export function focusTab(serviceWorker: Worker, tabId: number): Promise<void> {
  return serviceWorker.evaluate(async (id) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const tab = await chrome.tabs.update(id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }, tabId);
}

/** Unloads the tab as Chrome's Memory Saver does, and returns the id the tab has then. */
export function discardTab(serviceWorker: Worker, tabId: number): Promise<number> {
  return serviceWorker.evaluate(async (id) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const discarded = await chrome.tabs.discard(id);
    if (discarded?.id === undefined) throw new Error("Chrome did not discard the tab.");
    return discarded.id;
  }, tabId);
}

/**
 * Loads `url` in the tab, as typing it in the address bar would, and resolves once the tab shows
 * it: `tabs.update` resolves while the previous page may still be the one committed.
 */
export function navigateTab(serviceWorker: Worker, tabId: number, url: string): Promise<void> {
  return serviceWorker.evaluate(
    async ([id, address]) => {
      const { chrome } = globalThis as unknown as ChromeGlobal;
      const shown = new Promise<void>((resolve) => {
        const listener = (updated: number, _change: object, tab: ChromeTab) => {
          const done = tab.status === "complete" && tab.pendingUrl === undefined;
          if (updated !== id || !done || tab.url !== address) return;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      await chrome.tabs.update(id, { url: address });
      await shown;
    },
    [tabId, url] as const,
  );
}

/** Everything the extension stores, local and session storage alike, as one string. */
export function storedText(serviceWorker: Worker): Promise<string> {
  return serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const [local, session] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.session.get(null),
    ]);
    return JSON.stringify({ local, session });
  });
}

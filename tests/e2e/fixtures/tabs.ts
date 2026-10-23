import type { BrowserContext, Page, Worker } from "@playwright/test";

interface ChromeTab {
  id?: number;
  index: number;
  url?: string;
  active: boolean;
  splitViewId?: number;
}

interface ChromeGlobal {
  chrome: {
    tabs: { query(filter: object): Promise<ChromeTab[]> };
    storage: { session: { get(key: string): Promise<Record<string, unknown>> } };
  };
  // Exposed by the service worker in test builds only.
  recnrunOpenSession?: (tab?: ChromeTab) => Promise<void>;
  recnrunOpenDashboard?: () => Promise<void>;
}

const extensionPage = (serviceWorker: Worker, path: string) =>
  new URL(path, serviceWorker.url()).href;

export const dashboardUrl = (serviceWorker: Worker) =>
  extensionPage(serviceWorker, "dashboard.html");
export const sessionUrl = (serviceWorker: Worker) => extensionPage(serviceWorker, "session.html");

const pagesAt = (context: BrowserContext, url: string) =>
  context.pages().filter((page) => page.url().startsWith(url));

export const dashboardPages = (context: BrowserContext, serviceWorker: Worker) =>
  pagesAt(context, dashboardUrl(serviceWorker));

export const sessionPages = (context: BrowserContext, serviceWorker: Worker) =>
  pagesAt(context, sessionUrl(serviceWorker));

/** Every tab as Chrome reports it; Playwright emulates focus, so Chrome's tab state is the truth. */
export function chromeTabs(serviceWorker: Worker) {
  return serviceWorker.evaluate(async (session) => {
    const tabs = await (globalThis as unknown as ChromeGlobal).chrome.tabs.query({});
    return tabs.map((tab) => ({
      id: tab.id,
      index: tab.index,
      url: tab.url ?? "",
      session: tab.url?.startsWith(session) ?? false,
      active: tab.active,
      splitViewId: tab.splitViewId ?? -1,
    }));
  }, sessionUrl(serviceWorker));
}

/** The session's pane and the tab beside it in its Split View, if it is in one. */
export async function sessionSplit(serviceWorker: Worker) {
  const tabs = await chromeTabs(serviceWorker);
  const pane = tabs.find((tab) => tab.session);
  const split = pane?.splitViewId ?? -1;
  const partner = tabs.find((tab) => split !== -1 && tab.splitViewId === split && !tab.session);
  return { pane, partner };
}

/** Chrome's id for the tab showing `url`. */
export async function tabIdOf(serviceWorker: Worker, url: string): Promise<number | undefined> {
  const tabs = await chromeTabs(serviceWorker);
  return tabs.find((tab) => tab.url === url)?.id;
}

/** The tab the stored session records, or null when none runs. */
export function recordedTabId(serviceWorker: Worker): Promise<number | null> {
  return serviceWorker.evaluate(async () => {
    const stored = await (globalThis as unknown as ChromeGlobal).chrome.storage.session.get(
      "recording",
    );
    const session = stored.recording as { tabId?: number } | null | undefined;
    return session?.tabId ?? null;
  });
}

/** Runs the toolbar icon's action on the tab showing `page`, as a keyboard shortcut would. */
export function triggerSessionOn(serviceWorker: Worker, page: Page): Promise<void> {
  return serviceWorker.evaluate(async (url) => {
    const scope = globalThis as unknown as ChromeGlobal;
    if (!scope.recnrunOpenSession)
      throw new Error("The service worker does not expose openSession.");
    const tab = (await scope.chrome.tabs.query({})).find((each) => each.url === url);
    await scope.recnrunOpenSession(tab);
  }, page.url());
}

export function openDashboardFromBackground(serviceWorker: Worker): Promise<void> {
  return serviceWorker.evaluate(async () => {
    const open = (globalThis as unknown as ChromeGlobal).recnrunOpenDashboard;
    if (!open) throw new Error("The service worker does not expose openDashboard.");
    await open();
  });
}

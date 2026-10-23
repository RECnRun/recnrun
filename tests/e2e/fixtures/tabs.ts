import type { BrowserContext, Worker } from "@playwright/test";

interface ChromeTab {
  id?: number;
  index: number;
  url?: string;
  active: boolean;
  splitViewId?: number;
}

interface ChromeGlobal {
  chrome: { tabs: { query(filter: object): Promise<ChromeTab[]> } };
}

export const dashboardUrl = (serviceWorker: Worker) =>
  new URL("dashboard.html", serviceWorker.url()).href;

export const dashboardPages = (context: BrowserContext, serviceWorker: Worker) =>
  context.pages().filter((page) => page.url().startsWith(dashboardUrl(serviceWorker)));

/** Every tab as Chrome reports it, and whether it shows the dashboard. */
export function splitTabs(serviceWorker: Worker) {
  return serviceWorker.evaluate(async (dashboard) => {
    const tabs = await (globalThis as unknown as ChromeGlobal).chrome.tabs.query({});
    return tabs.map((tab) => ({
      id: tab.id,
      index: tab.index,
      dashboard: tab.url?.startsWith(dashboard) ?? false,
      active: tab.active,
      splitViewId: tab.splitViewId,
    }));
  }, dashboardUrl(serviceWorker));
}

/** The dashboard's tab and the page beside it in its Split View, if it is in one. */
export async function dashboardSplit(serviceWorker: Worker) {
  const tabs = await splitTabs(serviceWorker);
  const dashboard = tabs.find((tab) => tab.dashboard);
  const split = dashboard?.splitViewId ?? -1;
  const partner = tabs.find((tab) => split !== -1 && tab.splitViewId === split && !tab.dashboard);
  return { dashboard, partner };
}

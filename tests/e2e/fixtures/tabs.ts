import type { Worker } from "@playwright/test";

interface ChromeTab {
  id?: number;
  url?: string;
  active: boolean;
}

interface ChromeGlobal {
  chrome: {
    tabs: { query(filter: object): Promise<ChromeTab[]> };
    storage: { session: { get(key: string): Promise<Record<string, unknown>> } };
  };
}

export const sessionUrl = (serviceWorker: Worker) =>
  new URL("session.html", serviceWorker.url()).href;

/** Every tab as Chrome reports it; Playwright emulates focus, so Chrome's tab state is the truth. */
export function chromeTabs(serviceWorker: Worker) {
  return serviceWorker.evaluate(async () => {
    const tabs = await (globalThis as unknown as ChromeGlobal).chrome.tabs.query({});
    return tabs.map((tab) => ({ id: tab.id, url: tab.url ?? "", active: tab.active }));
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

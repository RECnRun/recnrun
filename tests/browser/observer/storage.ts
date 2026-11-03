import type { CDPSession } from "@playwright/test";

/** What one origin holds physically, as CDP's inspection commands report it. */
export interface OriginInventory {
  indexedDB: string[] | { error: string };
  cacheStorage: string[] | { error: string };
  usage: { usage: number; quota: number; byType: Record<string, number> } | { error: string };
  localStorage: string[] | { error: string };
  sessionStorage: string[] | { error: string };
}

export interface StorageSnapshot {
  takenAt: string;
  label?: string;
  origins: Record<string, OriginInventory>;
  /** Every cookie in the browser; values are hashed when the snapshot is written. */
  cookies: object[];
}

async function attempt<T>(read: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await read();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Keys only: values of Web Storage can hold tokens and are not needed to tell namespaces apart. */
async function webStorageKeys(page: CDPSession, origin: string, isLocalStorage: boolean) {
  const { entries } = await page.send("DOMStorage.getDOMStorageItems", {
    storageId: { storageKey: `${origin}/`, isLocalStorage },
  });
  return entries.map(([key]) => key ?? "");
}

async function usageOf(page: CDPSession, origin: string) {
  const { usage, quota, usageBreakdown } = await page.send("Storage.getUsageAndQuota", { origin });
  const used = usageBreakdown.filter((entry) => entry.usage > 0);
  return {
    usage,
    quota,
    byType: Object.fromEntries(used.map((entry) => [entry.storageType, entry.usage])),
  };
}

async function inventory(page: CDPSession, origin: string): Promise<OriginInventory> {
  return {
    indexedDB: await attempt(async () => {
      const result = await page.send("IndexedDB.requestDatabaseNames", {
        storageKey: `${origin}/`,
      });
      return result.databaseNames;
    }),
    cacheStorage: await attempt(async () => {
      const result = await page.send("CacheStorage.requestCacheNames", {
        storageKey: `${origin}/`,
      });
      return result.caches.map((cache) => cache.cacheName);
    }),
    usage: await attempt(() => usageOf(page, origin)),
    localStorage: await attempt(() => webStorageKeys(page, origin, true)),
    sessionStorage: await attempt(() => webStorageKeys(page, origin, false)),
  };
}

/**
 * Inventories `origins` through the page session and lists the browser's cookies through the
 * browser session. Every command here only reads.
 */
export async function takeSnapshot(
  sessions: { page: CDPSession; browser: CDPSession },
  origins: readonly string[],
  label?: string,
): Promise<StorageSnapshot> {
  const inventories: Record<string, OriginInventory> = {};
  for (const origin of origins) inventories[origin] = await inventory(sessions.page, origin);
  const { cookies } = await sessions.browser.send("Storage.getCookies");
  return {
    takenAt: new Date().toISOString(),
    ...(label ? { label } : {}),
    origins: inventories,
    cookies,
  };
}

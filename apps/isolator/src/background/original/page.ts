// chrome.scripting serializes each function into the page, so none may use an outer name.

/** Every way a page enumerates its stores, as the original session's page sees them. */
export async function listStores() {
  const storage = globalThis.localStorage;
  const forIn: string[] = [];
  // A page's own for-in also walks what the filter's proxy reports.
  for (const key in storage) forIn.push(key);
  const byIndex: string[] = [];
  for (let index = 0; index < storage.length; index += 1) byIndex.push(String(storage.key(index)));
  return {
    diagnostics: (Reflect.get(globalThis, "__recnrun") as unknown) ?? null,
    databases: (await indexedDB.databases()).map(({ name }) => String(name)),
    caches: await caches.keys(),
    localStorage: {
      keys: Object.keys(storage),
      forIn,
      byIndex,
      length: storage.length,
      json: JSON.stringify(storage),
    },
  };
}

/** What each store API did with `name`: `allowed`, or the error as `name: message`. */
export async function tryReservedNames(name: string): Promise<Record<string, string>> {
  const outcome = async (run: () => unknown): Promise<string> => {
    try {
      await run();
      return "allowed";
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  };
  const storage = globalThis.localStorage;
  return {
    "indexedDB.open": await outcome(() => indexedDB.open(name)),
    "indexedDB.deleteDatabase": await outcome(() => indexedDB.deleteDatabase(name)),
    "caches.open": await outcome(() => caches.open(name)),
    "caches.has": await outcome(() => caches.has(name)),
    "caches.delete": await outcome(() => caches.delete(name)),
    "caches.match": await outcome(() => caches.match("/", { cacheName: name })),
    "localStorage.setItem": await outcome(() => storage.setItem(name, "page")),
    "localStorage.getItem": await outcome(() => storage.getItem(name)),
    "localStorage.removeItem": await outcome(() => storage.removeItem(name)),
  };
}

/** What a page's "clear site data" does: delete every listed store, then clear localStorage. */
export async function clearLikeAPage() {
  const databases = (await indexedDB.databases()).map(({ name }) => String(name));
  for (const name of databases) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
  const cacheNames = await caches.keys();
  for (const name of cacheNames) await caches.delete(name);
  globalThis.localStorage.clear();
  return { databases, caches: cacheNames };
}

/** Run in the isolated world, which shares the page's storage but none of its patches. */
export function seedStorage(key: string, value: string): string | null {
  globalThis.localStorage.setItem(key, value);
  return globalThis.localStorage.getItem(key);
}

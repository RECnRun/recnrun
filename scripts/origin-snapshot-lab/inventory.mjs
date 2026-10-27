// What an origin keeps, by name, count, and size only: never a value, since a real app's storage
// holds tokens and personal data.

/** Runs in the page: IndexedDB schemas and counts, web storage key sizes, caches, service workers. */
export async function pageInventory() {
  const settle = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const describeStore = async (db, name) => {
    const store = db.transaction(name).objectStore(name);
    const indexes = [...store.indexNames].map((index) => {
      const { keyPath, unique, multiEntry } = store.index(index);
      return { name: index, keyPath, unique, multiEntry };
    });
    const count = await settle(store.count());
    return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, count };
  };
  const describeDatabase = async ({ name, version }) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => request.transaction.abort();
    const db = await settle(request);
    const stores = await Promise.all(
      [...db.objectStoreNames].map((store) => describeStore(db, store)),
    );
    db.close();
    return { name, version, stores };
  };
  const sizes = (storage) =>
    Object.keys(storage)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => ({ key, chars: storage.getItem(key)?.length ?? 0 }));
  const describeCache = async (name) => ({
    name,
    entries: (await (await caches.open(name)).keys()).length,
  });
  // Insecure origins have no navigator.serviceWorker.
  const workers =
    "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistrations() : [];
  const infos = (await indexedDB.databases()).filter((info) => info.name);
  return {
    origin: location.origin,
    path: location.pathname,
    estimate: await navigator.storage.estimate(),
    databases: await Promise.all(infos.map(describeDatabase)),
    localStorage: sizes(localStorage),
    sessionStorage: sizes(sessionStorage),
    caches: await Promise.all((await caches.keys()).map(describeCache)),
    serviceWorkers: workers.map((worker) => ({
      scope: worker.scope,
      active: worker.active?.state,
    })),
  };
}

/** The context's cookies without their values. */
export async function cookieInventory(context) {
  return (await context.cookies()).map(({ value, ...cookie }) => ({
    ...cookie,
    chars: value.length,
  }));
}

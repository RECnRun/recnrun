/** Resolves with a request's result, or rejects with its error. */
export function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Request failed.")));
  });
}

/** Deletes this page's databases, so each test starts as a fresh Incognito origin would. */
export async function clearDatabases(): Promise<void> {
  for (const { name } of await indexedDB.databases()) {
    if (name !== undefined) await settled(indexedDB.deleteDatabase(name));
  }
}

/** Every record of a store as `[key, value]`, with the database's version and the store's shape and indexes. */
export async function readStore(database: string, store: string) {
  const connection = await settled(indexedDB.open(database));
  try {
    const objectStore = connection.transaction(store).objectStore(store);
    const [keys, values] = await Promise.all([
      settled(objectStore.getAllKeys()),
      settled(objectStore.getAll()),
    ]);
    const indexes = Array.from(objectStore.indexNames, (name) => {
      const { keyPath, unique, multiEntry } = objectStore.index(name);
      return { name, keyPath, unique, multiEntry };
    });
    return {
      version: connection.version,
      keyPath: objectStore.keyPath,
      autoIncrement: objectStore.autoIncrement,
      indexes,
      records: keys.map((key, index) => [key, values[index]]),
    };
  } finally {
    connection.close();
  }
}

/**
 * A Web Storage of its own: the Vitest UI shares the test page's origin and writes its own keys
 * to localStorage, so the real one is never empty.
 */
export function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => items.delete(key),
    setItem: (key, value) => items.set(key, value),
  };
}

/** A Storage's entries as a plain object. */
export function entriesOf(storage: Storage): Record<string, string> {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "");
  return Object.fromEntries(keys.map((key) => [key, storage.getItem(key) ?? ""]));
}

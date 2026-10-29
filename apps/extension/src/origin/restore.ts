import type { OriginData } from "@recnrun/domain";
import type { RestoredCounts, StorageScope, UnsupportedEntry } from "@/messaging/origin-protocol";
import { cacheCount, writeCaches } from "@/origin/cache-storage";
import { OriginFailure, step } from "@/origin/failure";
import { writeEntries } from "@/origin/web-storage";

/** The page's own storage, as the agent sees it from its isolated world. */
export interface OriginStores {
  localStorage: Storage;
  sessionStorage: Storage;
  indexedDB: IDBFactory;
  /** Absent outside a secure context, where Chrome exposes no Cache Storage. */
  caches: CacheStorage | undefined;
}

type Database = OriginData["indexedDB"][number];

/** Restoring merges into nothing: a fresh Incognito origin holds no data, so any data is a mistake. */
async function requireEmpty(stores: OriginStores): Promise<void> {
  const databases = await stores.indexedDB.databases();
  const caches = await cacheCount(stores.caches);
  if (stores.localStorage.length + stores.sessionStorage.length + databases.length + caches > 0) {
    throw new OriginFailure("check", "OriginNotEmpty");
  }
}

function createStores(connection: IDBDatabase, database: Database): void {
  for (const { name, keyPath, autoIncrement, indexes } of database.stores) {
    const store = connection.createObjectStore(name, { keyPath, autoIncrement });
    for (const { name: index, keyPath: path, unique, multiEntry } of indexes) {
      store.createIndex(index, path, { unique, multiEntry });
    }
  }
}

function openCreating(factory: IDBFactory, database: Database): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(database.name, database.version);
    request.addEventListener("upgradeneeded", () => {
      try {
        createStores(request.result, database);
      } catch (error) {
        // Thrown from a listener, it would surface as the page's uncaught error.
        request.transaction?.abort();
        reject(error);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new DOMException("Open failed.", "UnknownError")),
    );
  });
}

function queuePuts(transaction: IDBTransaction, database: Database): number {
  let count = 0;
  for (const store of database.stores) {
    const objectStore = transaction.objectStore(store.name);
    for (const { key, value } of store.records) {
      // An in-line key path refuses an explicit key; the browser validates the captured one.
      objectStore.put(value, store.keyPath === null ? (key as IDBValidKey | undefined) : undefined);
      count += 1;
    }
  }
  return count;
}

/** Resolves only after the transaction's `complete`; a refused record aborts every one. */
function putRecords(connection: IDBDatabase, database: Database): Promise<number> {
  const names = database.stores.map(({ name }) => name);
  if (names.length === 0) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(names, "readwrite");
    let count = 0;
    transaction.addEventListener("complete", () => resolve(count));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new DOMException("Aborted.", "AbortError")),
    );
    try {
      count = queuePuts(transaction, database);
    } catch (error) {
      // A put that throws does not abort by itself; the earlier puts would commit.
      transaction.abort();
      reject(error);
    }
  });
}

async function restoreDatabase(factory: IDBFactory, database: Database): Promise<number> {
  const connection = await openCreating(factory, database);
  try {
    return await putRecords(connection, database);
  } finally {
    connection.close();
  }
}

/** Writes a tab's own sessionStorage into it, beside the origin's data another tab restored. */
async function restoreSession(stores: OriginStores, data: OriginData): Promise<RestoredCounts> {
  if (stores.sessionStorage.length > 0) throw new OriginFailure("check", "OriginNotEmpty");
  const sessionStorage = await step("sessionStorage", () =>
    writeEntries(stores.sessionStorage, data.sessionStorage),
  );
  return {
    localStorage: 0,
    sessionStorage,
    databases: 0,
    records: 0,
    caches: 0,
    cacheEntries: 0,
  };
}

/**
 * Writes one origin's data into its empty storage and counts what it wrote, adding to `rebuilt`
 * each fetched cache entry it wrote as captured; a session scope writes the tab's sessionStorage
 * alone.
 */
export async function restoreOrigin(
  stores: OriginStores,
  data: OriginData,
  scope: StorageScope = "origin",
  rebuilt: UnsupportedEntry[] = [],
): Promise<RestoredCounts> {
  if (scope === "session") return restoreSession(stores, data);
  await step("check", () => requireEmpty(stores));
  const localStorage = await step("localStorage", () =>
    writeEntries(stores.localStorage, data.localStorage),
  );
  const sessionStorage = await step("sessionStorage", () =>
    writeEntries(stores.sessionStorage, data.sessionStorage),
  );
  let records = 0;
  for (const database of data.indexedDB) {
    // One database at a time, so a failure names no later database as half written.
    records += await step("indexedDB", () => restoreDatabase(stores.indexedDB, database));
  }
  const written = await step("cacheStorage", () => writeCaches(stores.caches, data.caches));
  rebuilt.push(...written.rebuilt);
  return {
    localStorage,
    sessionStorage,
    databases: data.indexedDB.length,
    records,
    caches: data.caches.length,
    cacheEntries: written.entries,
  };
}

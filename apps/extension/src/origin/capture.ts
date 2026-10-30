import type { OriginData } from "@recnrun/domain";
import type { CapturedCounts, StorageScope } from "@/messaging/origin-protocol";
import { readCaches } from "@/origin/cache-storage";
import type { CacheSink } from "@/origin/cache-storage";
import { step } from "@/origin/failure";
import type { OriginStores } from "@/origin/restore";
import { readEntries } from "@/origin/web-storage";

type Database = OriginData["indexedDB"][number];
type Store = Database["stores"][number];
type Records = Store["records"];

/**
 * Where a capture sends Web Storage, then each database's schema and its records, a chunk at a
 * time, then each cache.
 */
export interface CaptureSink {
  storage: (entries: Pick<OriginData, "localStorage" | "sessionStorage">) => void;
  database: (database: Database) => void;
  records: (database: string, store: string, records: Records) => void;
  cache: CacheSink;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new DOMException("Request failed.", "UnknownError")),
    );
  });
}

/** Opens a listed database as it is; one that vanished meanwhile is not created by the open. */
async function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name);
  request.addEventListener("upgradeneeded", () => request.transaction?.abort());
  const connection = await settled(request);
  // A page that upgrades its database meanwhile must not wait on this capture.
  connection.addEventListener("versionchange", () => connection.close());
  return connection;
}

function schemaOf(objectStore: IDBObjectStore): Store {
  const indexes = Array.from(objectStore.indexNames, (name) => {
    const { keyPath, unique, multiEntry } = objectStore.index(name);
    return { name, keyPath, unique, multiEntry };
  });
  const { name, keyPath, autoIncrement } = objectStore;
  return { name, keyPath, autoIncrement, indexes, records: [] };
}

/** Sends `objectStore`'s records in key order, `chunk` at a time, and counts them. */
async function pageStore(
  objectStore: IDBObjectStore,
  send: (records: Records) => void,
  chunk: number,
): Promise<number> {
  // An in-line key is already in the value; only out-of-line keys travel next to it.
  const inline = objectStore.keyPath !== null;
  let range: IDBKeyRange | undefined;
  let count = 0;
  for (;;) {
    const [keys, values] = await Promise.all([
      settled(objectStore.getAllKeys(range, chunk)),
      settled(objectStore.getAll(range, chunk)),
    ]);
    if (keys.length > 0) {
      send(keys.map((key, at) => (inline ? { value: values[at] } : { key, value: values[at] })));
      count += keys.length;
    }
    if (keys.length < chunk) return count;
    range = IDBKeyRange.lowerBound(keys.at(-1), true);
  }
}

/** Sends one database's schema, then its records, all read in one transaction. */
async function captureDatabase(
  connection: IDBDatabase,
  sink: CaptureSink,
  chunk: number,
): Promise<number> {
  const names = Array.from(connection.objectStoreNames);
  const { name, version } = connection;
  if (names.length === 0) {
    sink.database({ name, version, stores: [] });
    return 0;
  }
  const transaction = connection.transaction(names, "readonly");
  const stores = names.map((store) => transaction.objectStore(store));
  sink.database({ name, version, stores: stores.map(schemaOf) });
  let records = 0;
  for (const objectStore of stores) {
    const send = (page: Records) => sink.records(name, objectStore.name, page);
    records += await pageStore(objectStore, send, chunk);
  }
  return records;
}

/** Reads every database of the page's origin into `sink` and counts the databases and records. */
async function captureDatabases(factory: IDBFactory, sink: CaptureSink, chunk: number) {
  const listed = await step("indexedDB", () => factory.databases());
  let records = 0;
  for (const { name = "" } of listed) {
    // One database at a time, each in its own connection, closed whatever happens.
    records += await step("indexedDB", async () => {
      const connection = await openExisting(factory, name);
      try {
        return await captureDatabase(connection, sink, chunk);
      } finally {
        connection.close();
      }
    });
  }
  return { databases: listed.length, records };
}

const NOTHING = { databases: 0, records: 0, caches: 0, cacheEntries: 0 };

/**
 * Reads the page's Web Storage, IndexedDB, then Cache Storage into `sink` and counts what it sent;
 * a session scope reads the tab's sessionStorage alone.
 */
export async function captureOrigin(
  stores: OriginStores,
  sink: CaptureSink,
  chunk: number,
  scope: StorageScope = "origin",
): Promise<CapturedCounts> {
  const sessionStorage = await step("sessionStorage", () => readEntries(stores.sessionStorage));
  if (scope === "session") {
    sink.storage({ localStorage: {}, sessionStorage });
    return { localStorage: 0, sessionStorage: Object.keys(sessionStorage).length, ...NOTHING };
  }
  const localStorage = await step("localStorage", () => readEntries(stores.localStorage));
  sink.storage({ localStorage, sessionStorage });
  const counts = await captureDatabases(stores.indexedDB, sink, chunk);
  const caches = await step("cacheStorage", () => readCaches(stores.caches, sink.cache));
  return {
    localStorage: Object.keys(localStorage).length,
    sessionStorage: Object.keys(sessionStorage).length,
    ...counts,
    ...caches,
  };
}

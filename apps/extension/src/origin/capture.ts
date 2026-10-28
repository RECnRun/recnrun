import type { OriginData } from "@recnrun/domain";
import type { CapturedCounts } from "@/messaging/origin-protocol";
import { step } from "@/origin/failure";

type Database = OriginData["indexedDB"][number];
type Store = Database["stores"][number];
type Records = Store["records"];

/** Where a capture sends each database's schema, then its records, a chunk at a time. */
export interface CaptureSink {
  database: (database: Database) => void;
  records: (database: string, store: string, records: Records) => void;
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

/** Reads every database of the page's origin into `sink` and counts what it sent. */
export async function captureOrigin(
  factory: IDBFactory,
  sink: CaptureSink,
  chunk: number,
): Promise<CapturedCounts> {
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

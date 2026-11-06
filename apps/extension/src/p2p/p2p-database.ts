const DB_NAME = "recnrun-p2p";
/** Version 2 added the folder; the upgrade keeps the certificate, and with it the pairing. */
const VERSION = 2;
const STORES = ["certificates", "folders"] as const;

type Store = (typeof STORES)[number];

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed."));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const store of STORES)
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
  };
  return settle(request);
}

async function inStore<T>(
  store: Store,
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await settle(run(db.transaction(store, mode).objectStore(store)));
  } finally {
    db.close();
  }
}

/**
 * What this profile keeps for the link in IndexedDB, which holds what chrome.storage cannot: an
 * RTCCertificate and a folder handle are structured-cloneable, but not JSON.
 */
export const readStored = (store: Store, key: string): Promise<unknown> =>
  inStore(store, "readonly", (objects) => objects.get(key));

export const writeStored = async (store: Store, key: string, value: unknown): Promise<void> =>
  void (await inStore(store, "readwrite", (objects) => objects.put(value, key)));

/** Stores `value` unless `key` holds one already, and says whether it did: a first write wins. */
export const addStored = (store: Store, key: string, value: unknown): Promise<boolean> =>
  inStore(store, "readwrite", (objects) => objects.add(value, key)).then(
    () => true,
    (error: unknown) => {
      if (error instanceof DOMException && error.name === "ConstraintError") return false;
      throw error;
    },
  );

export const deleteStored = async (store: Store, key: string): Promise<void> =>
  await inStore(store, "readwrite", (objects) => objects.delete(key));

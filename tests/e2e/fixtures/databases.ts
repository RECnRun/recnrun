import type { Page } from "@playwright/test";

/** One store as the page's IndexedDB holds it; keys and values tagged so they survive JSON. */
interface DumpedStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
  records: unknown[];
}

export interface DumpedDatabase {
  name: string;
  version: number;
  stores: DumpedStore[];
}

/**
 * Identity A's schema at version 3: indexes, in-line, out-of-line, composite, Date, and binary
 * keys, an empty store, a second database, and an `autoIncrement` store whose highest key is gone.
 */
export const writeSchemaA = (page: Page) =>
  page.evaluate(async () => {
    const opened = (name: string, version: number, upgrade: (db: IDBDatabase) => void) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => upgrade(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("open failed"));
      });
    const shop = await opened("shop", 3, (db) => {
      const products = db.createObjectStore("products", { keyPath: "sku" });
      products.createIndex("byName", "name", { unique: true });
      products.createIndex("byTag", "tags", { multiEntry: true });
      db.createObjectStore("orders", { autoIncrement: true });
      db.createObjectStore("people", { keyPath: ["last", "first"] }).createIndex("byLast", "last");
      db.createObjectStore("events");
      db.createObjectStore("empty");
    });
    const names = ["products", "orders", "people", "events"];
    const transaction = shop.transaction(names, "readwrite");
    for (const sku of ["p1", "p2", "p3"]) {
      transaction.objectStore("products").put({ sku, name: `Name ${sku}`, tags: ["a", sku] });
    }
    for (const total of [10, 20, 30]) {
      transaction.objectStore("orders").add({ total, at: new Date(total) });
    }
    transaction.objectStore("orders").delete(3);
    transaction.objectStore("people").put({ last: "Doe", first: "Ann" });
    transaction.objectStore("events").put("by date", new Date(5));
    transaction.objectStore("events").put("by bytes", new Uint8Array([1, 2, 3]).buffer);
    transaction.objectStore("events").put("by array", ["a", 1]);
    await new Promise((resolve) => (transaction.oncomplete = resolve));
    shop.close();
    const extra = await opened("extra", 1, (db) => db.createObjectStore("kv"));
    const kv = extra.transaction("kv", "readwrite");
    kv.objectStore("kv").put("A", "owner");
    await new Promise((resolve) => (kv.oncomplete = resolve));
    extra.close();
  });

/** Identity B's schema at version 5: other stores, other indexes, and no second database. */
export const writeSchemaB = (page: Page) =>
  page.evaluate(async () => {
    const shop = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("shop", 5);
      request.onupgradeneeded = () => {
        const products = request.result.createObjectStore("products", { keyPath: "id" });
        products.createIndex("byPrice", "price");
        request.result.createObjectStore("audit", { keyPath: "at", autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const transaction = shop.transaction(["products", "audit"], "readwrite");
    transaction.objectStore("products").put({ id: 1, price: 5 });
    transaction.objectStore("audit").put({ what: "B" });
    await new Promise((resolve) => (transaction.oncomplete = resolve));
    shop.close();
  });

/** Every database of the page's origin, by name, with its schema and records. */
export const dumpDatabases = (page: Page): Promise<DumpedDatabase[]> =>
  page.evaluate(async () => {
    const result = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("request failed"));
      });
    // Dates and binary keys would not survive the trip to the test as they are.
    const tagged = (value: unknown): unknown => {
      if (value instanceof Date) return { Date: value.toISOString() };
      if (value instanceof ArrayBuffer) return { ArrayBuffer: [...new Uint8Array(value)] };
      if (Array.isArray(value)) return value.map(tagged);
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, tagged(inner)]));
    };
    const listed = await indexedDB.databases();
    const names = listed.map(({ name }) => name ?? "").toSorted();
    const dumped = [];
    for (const name of names) {
      const db = await result(indexedDB.open(name));
      const stores = [];
      for (const storeName of Array.from(db.objectStoreNames)) {
        const store = db.transaction(storeName).objectStore(storeName);
        const indexes = Array.from(store.indexNames, (indexName) => {
          const { keyPath, unique, multiEntry } = store.index(indexName);
          return { name: indexName, keyPath, unique, multiEntry };
        });
        const [keys, values] = await Promise.all([
          result(store.getAllKeys()),
          result(store.getAll()),
        ]);
        const records = tagged(keys.map((key, index) => [key, values[index]])) as unknown[];
        const { keyPath, autoIncrement } = store;
        stores.push({ name: storeName, keyPath, autoIncrement, indexes, records });
      }
      dumped.push({ name, version: db.version, stores });
      db.close();
    }
    return dumped;
  });

/** The key the page's `shop.orders` store generates next; the added record is rolled back. */
export const nextOrderKey = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("shop");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const transaction = db.transaction("orders", "readwrite");
    const key = await new Promise<IDBValidKey>((resolve, reject) => {
      const request = transaction.objectStore("orders").add({ total: 0 });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("add failed"));
    });
    transaction.abort();
    db.close();
    return key;
  });

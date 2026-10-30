import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { OriginData } from "@recnrun/domain";
import { captureOrigin } from "@/origin/capture";
import { restoreOrigin } from "@/origin/restore";
import { clearDatabases, memoryStorage, readStore, settled } from "./origin-storage";

type Database = OriginData["indexedDB"][number];
type Records = Database["stores"][number]["records"];

const tag = new Uint8Array([1, 2, 3]).buffer;

/** Creates `name` at `version` with `upgrade`, then runs `fill` in one readwrite transaction. */
async function createDatabase(
  name: string,
  version: number,
  upgrade: (connection: IDBDatabase) => void,
  fill: (transaction: IDBTransaction) => void = () => {},
) {
  const opening = indexedDB.open(name, version);
  opening.addEventListener("upgradeneeded", () => upgrade(opening.result));
  const connection = await settled(opening);
  const names = Array.from(connection.objectStoreNames);
  if (names.length > 0) {
    const transaction = connection.transaction(names, "readwrite");
    fill(transaction);
    await new Promise((resolve) => transaction.addEventListener("complete", resolve));
  }
  connection.close();
}

/** The shop the cases need: indexes, in-line, out-of-line, composite, Date, and binary keys. */
async function createShop() {
  await createDatabase(
    "shop",
    3,
    (connection) => {
      const products = connection.createObjectStore("products", { keyPath: "sku" });
      products.createIndex("byName", "name", { unique: true });
      products.createIndex("byTag", "tags", { multiEntry: true });
      connection.createObjectStore("orders", { autoIncrement: true });
      connection
        .createObjectStore("people", { keyPath: ["last", "first"] })
        .createIndex("byLast", "last");
      connection.createObjectStore("events");
      connection.createObjectStore("empty");
    },
    (transaction) => {
      const products = transaction.objectStore("products");
      for (const sku of ["p1", "p2", "p3", "p4", "p5"]) {
        products.put({ sku, name: `Name ${sku}`, tags: ["office", sku] });
      }
      const orders = transaction.objectStore("orders");
      for (const total of [10, 20, 30]) orders.add({ total, at: new Date(total) });
      // Deleting the highest generated key leaves a generator ahead of the data.
      orders.delete(3);
      transaction.objectStore("people").put({ last: "Doe", first: "Ann" });
      const events = transaction.objectStore("events");
      events.put("by date", new Date(5));
      events.put("by bytes", tag);
      events.put("by array", ["a", 1]);
    },
  );
  await createDatabase("blank", 1, () => {});
}

type WebStorage = Pick<OriginData, "localStorage" | "sessionStorage">;

const emptyStores = () => ({
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  indexedDB,
  caches: undefined,
});

/** Runs a capture and rebuilds its storage and databases from the messages it sent, in their order. */
async function captured(chunk: number, stores = emptyStores()) {
  const databases: Database[] = [];
  const pages: { store: string; size: number }[] = [];
  const sent: WebStorage[] = [];
  const counts = await captureOrigin(
    stores,
    {
      storage: (entries) => sent.push(entries),
      database: (database) => databases.push(database),
      records: (database: string, store: string, records: Records) => {
        const target = databases.find(({ name }) => name === database);
        target?.stores.find(({ name }) => name === store)?.records.push(...records);
        pages.push({ store, size: records.length });
      },
      cache: vi.fn(),
    },
    chunk,
  );
  expect(sent).toHaveLength(1);
  return { counts, databases, pages, storage: sent[0] };
}

/** Every store of `database` as the browser holds it. */
async function storesOf(database: string, names: string[]) {
  return Promise.all(names.map((name) => readStore(database, name)));
}

const SHOP_STORES = ["empty", "events", "orders", "people", "products"];

beforeEach(clearDatabases);

afterEach(async () => {
  vi.restoreAllMocks();
  await clearDatabases();
});

test("captures every database's version, stores, key paths, indexes, and records", async () => {
  await createShop();
  const close = vi.spyOn(IDBDatabase.prototype, "close");
  const { counts, databases } = await captured(500);
  expect(counts).toEqual({
    localStorage: 0,
    sessionStorage: 0,
    databases: 2,
    records: 11,
    caches: 0,
    cacheEntries: 0,
  });
  expect(close).toHaveBeenCalledTimes(2);

  const blank = databases.find(({ name }) => name === "blank");
  expect(blank).toEqual({ name: "blank", version: 1, stores: [] });
  const shop = databases.find(({ name }) => name === "shop");
  expect(shop?.version).toBe(3);
  const byName = Object.fromEntries((shop?.stores ?? []).map((store) => [store.name, store]));
  expect(byName.products).toMatchObject({
    keyPath: "sku",
    autoIncrement: false,
    indexes: [
      { name: "byName", keyPath: "name", unique: true, multiEntry: false },
      { name: "byTag", keyPath: "tags", unique: false, multiEntry: true },
    ],
  });
  // In-line keys stay in the value; out-of-line keys travel next to it.
  expect(byName.products?.records[0]).toEqual({
    value: { sku: "p1", name: "Name p1", tags: ["office", "p1"] },
  });
  expect(byName.orders).toMatchObject({ keyPath: null, autoIncrement: true });
  expect(byName.orders?.records).toEqual([
    { key: 1, value: { total: 10, at: new Date(10) } },
    { key: 2, value: { total: 20, at: new Date(20) } },
  ]);
  expect(byName.people).toMatchObject({
    keyPath: ["last", "first"],
    indexes: [{ name: "byLast", keyPath: "last", unique: false, multiEntry: false }],
    records: [{ value: { last: "Doe", first: "Ann" } }],
  });
  const keys = byName.events?.records.map(({ key }) => key);
  expect(keys).toEqual([new Date(5), tag, ["a", 1]]);
  expect(keys?.[1]).toBeInstanceOf(ArrayBuffer);
  expect(byName.empty?.records).toEqual([]);
});

test("reads each store in chunks of the asked size, in key order", async () => {
  await createShop();
  const { pages, databases } = await captured(2);
  expect(pages.filter(({ store }) => store === "products").map(({ size }) => size)).toEqual([
    2, 2, 1,
  ]);
  const shop = databases.find(({ name }) => name === "shop");
  const products = shop?.stores.find(({ name }) => name === "products")?.records;
  expect(products?.map(({ value }) => (value as { sku: string }).sku)).toEqual([
    "p1",
    "p2",
    "p3",
    "p4",
    "p5",
  ]);
  // A full last chunk ends with an empty read, which sends nothing.
  expect(pages.filter(({ store }) => store === "orders").map(({ size }) => size)).toEqual([2]);
});

test("a captured origin restores into an empty one as it was, its schema and keys included", async () => {
  await createShop();
  const before = await storesOf("shop", SHOP_STORES);
  const { databases } = await captured(2);
  await clearDatabases();

  const site = { localStorage: {}, sessionStorage: {}, indexedDB: databases, caches: [] };
  await expect(restoreOrigin(emptyStores(), site)).resolves.toMatchObject({
    databases: 2,
    records: 11,
  });
  await expect(storesOf("shop", SHOP_STORES)).resolves.toEqual(before);
  const listed = await indexedDB.databases();
  expect(listed.map(({ name, version }) => `${name}@${version}`).toSorted()).toEqual([
    "blank@1",
    "shop@3",
  ]);
});

test("after the highest generated key was deleted, the restored generator continues from the data", async () => {
  await createShop();
  const { databases } = await captured(500);
  const nextKey = async () => {
    const connection = await settled(indexedDB.open("shop"));
    const transaction = connection.transaction("orders", "readwrite");
    const key = await settled(transaction.objectStore("orders").add({ total: 0 }));
    transaction.abort();
    connection.close();
    return key;
  };
  // The source's generator remembers the deleted key 3; restoring writes only keys 1 and 2.
  await expect(nextKey()).resolves.toBe(4);
  await clearDatabases();
  await restoreOrigin(emptyStores(), {
    localStorage: {},
    sessionStorage: {},
    indexedDB: databases,
    caches: [],
  });
  await expect(nextKey()).resolves.toBe(3);
});

test("a database that vanished before it opened fails the capture and is not created", async () => {
  vi.spyOn(indexedDB, "databases").mockResolvedValue([{ name: "ghost", version: 1 }]);
  const sink = { storage: vi.fn(), database: vi.fn(), records: vi.fn(), cache: vi.fn() };
  await expect(captureOrigin(emptyStores(), sink, 500)).rejects.toMatchObject({
    name: "OriginFailure",
    message: "indexedDB: AbortError",
  });
  expect(sink.database).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await expect(indexedDB.databases()).resolves.toEqual([]);
});

test("an origin without data captures nothing", async () => {
  const sink = { storage: vi.fn(), database: vi.fn(), records: vi.fn(), cache: vi.fn() };
  await expect(captureOrigin(emptyStores(), sink, 500)).resolves.toEqual({
    localStorage: 0,
    sessionStorage: 0,
    databases: 0,
    records: 0,
    caches: 0,
    cacheEntries: 0,
  });
  expect(sink.storage).toHaveBeenCalledExactlyOnceWith({ localStorage: {}, sessionStorage: {} });
  expect(sink.database).not.toHaveBeenCalled();
});

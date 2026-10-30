import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { OriginData } from "@recnrun/domain";
import { restoreOrigin } from "@/origin/restore";
import type { OriginStores } from "@/origin/restore";
import { clearDatabases, entriesOf, memoryStorage, readStore, settled } from "./origin-storage";

const avatar = new Blob(["avatar"], { type: "image/png" });

const data: OriginData = {
  localStorage: { theme: "dark", token: "secret-1" },
  sessionStorage: { tab: "3" },
  caches: [],
  indexedDB: [
    {
      name: "app",
      version: 4,
      stores: [
        {
          name: "kv",
          keyPath: null,
          autoIncrement: false,
          indexes: [],
          records: [
            { key: "marker", value: { at: new Date(0), avatar } },
            { key: 2, value: "two" },
          ],
        },
        {
          name: "people",
          keyPath: ["last", "first"],
          autoIncrement: false,
          indexes: [
            { name: "byFirst", keyPath: "first", unique: true, multiEntry: false },
            { name: "byTag", keyPath: "tags", unique: false, multiEntry: true },
          ],
          records: [{ value: { last: "Doe", first: "Ann" } }],
        },
        {
          name: "log",
          keyPath: "id",
          autoIncrement: true,
          indexes: [],
          records: [{ value: { text: "a" } }],
        },
      ],
    },
    { name: "empty", version: 1, stores: [] },
  ],
};

let stores: OriginStores;

beforeEach(async () => {
  await clearDatabases();
  stores = {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    indexedDB,
    caches: undefined,
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearDatabases();
});

test("restores Web Storage and IndexedDB, with versions, store shapes, and record types", async () => {
  const close = vi.spyOn(IDBDatabase.prototype, "close");
  await expect(restoreOrigin(stores, data)).resolves.toEqual({
    localStorage: 2,
    sessionStorage: 1,
    databases: 2,
    records: 4,
    caches: 0,
    cacheEntries: 0,
  });
  // Restoring closed its connection to each database before resolving.
  expect(close).toHaveBeenCalledTimes(2);
  expect(entriesOf(stores.localStorage)).toEqual(data.localStorage);
  expect(entriesOf(stores.sessionStorage)).toEqual(data.sessionStorage);

  const kv = await readStore("app", "kv");
  expect(kv).toMatchObject({ version: 4, keyPath: null, autoIncrement: false });
  expect(kv.records).toEqual([
    [2, "two"],
    ["marker", { at: new Date(0), avatar: expect.any(Blob) }],
  ]);
  const [, marker] = kv.records[1] ?? [];
  await expect((marker as { avatar: Blob }).avatar.text()).resolves.toBe("avatar");

  await expect(readStore("app", "people")).resolves.toMatchObject({
    keyPath: ["last", "first"],
    indexes: [
      { name: "byFirst", keyPath: "first", unique: true, multiEntry: false },
      { name: "byTag", keyPath: "tags", unique: false, multiEntry: true },
    ],
    records: [[["Doe", "Ann"], { last: "Doe", first: "Ann" }]],
  });
  await expect(readStore("app", "log")).resolves.toMatchObject({
    keyPath: "id",
    autoIncrement: true,
    records: [[1, { id: 1, text: "a" }]],
  });
  const databases = await indexedDB.databases();
  expect(databases.map(({ name, version }) => `${name}@${version}`).toSorted()).toEqual([
    "app@4",
    "empty@1",
  ]);
});

test("refuses an origin that already holds data, and writes nothing", async () => {
  stores.sessionStorage.setItem("left", "over");
  await expect(restoreOrigin(stores, data)).rejects.toMatchObject({
    name: "OriginFailure",
    message: "check: OriginNotEmpty",
  });
  expect(entriesOf(stores.sessionStorage)).toEqual({ left: "over" });
  expect(stores.localStorage.length).toBe(0);
  await expect(indexedDB.databases()).resolves.toEqual([]);

  stores.sessionStorage.clear();
  (await settled(indexedDB.open("left"))).close();
  await expect(restoreOrigin(stores, data)).rejects.toMatchObject({
    message: "check: OriginNotEmpty",
  });
  await expect(indexedDB.databases()).resolves.toEqual([{ name: "left", version: 1 }]);
});

test("a record that cannot be stored aborts its whole transaction, and the failure names no value", async () => {
  const unkeyed: OriginData = {
    localStorage: {},
    sessionStorage: {},
    caches: [],
    indexedDB: [
      {
        name: "app",
        version: 1,
        stores: [
          {
            name: "kv",
            keyPath: null,
            autoIncrement: false,
            indexes: [],
            records: [{ key: "first", value: "secret-2" }, { value: "secret-3" }],
          },
        ],
      },
    ],
  };
  const close = vi.spyOn(IDBDatabase.prototype, "close");
  const failure = await restoreOrigin(stores, unkeyed).catch((error: unknown) => error);
  expect(failure).toMatchObject({ name: "OriginFailure", message: "indexedDB: DataError" });
  expect(close).toHaveBeenCalledOnce();
  await expect(readStore("app", "kv")).resolves.toMatchObject({ records: [] });
});

test("a store the database cannot create fails the restore", async () => {
  const twice: OriginData = {
    localStorage: {},
    sessionStorage: {},
    caches: [],
    indexedDB: [
      {
        name: "app",
        version: 1,
        stores: [
          { name: "kv", keyPath: null, autoIncrement: false, indexes: [], records: [] },
          { name: "kv", keyPath: null, autoIncrement: false, indexes: [], records: [] },
        ],
      },
    ],
  };
  await expect(restoreOrigin(stores, twice)).rejects.toMatchObject({
    name: "OriginFailure",
    message: expect.stringMatching(/^indexedDB: /),
  });
});

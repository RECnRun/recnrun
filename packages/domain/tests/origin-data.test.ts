import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { OriginDataSchema } from "../src/index.ts";
import type { OriginData } from "../src/index.ts";

const bytes = new Uint8Array([1, 2]);
const data: OriginData = {
  localStorage: { theme: "dark" },
  sessionStorage: {},
  indexedDB: [
    {
      name: "app",
      version: 3,
      stores: [
        {
          name: "kv",
          keyPath: null,
          autoIncrement: false,
          indexes: [{ name: "byAt", keyPath: "at", unique: false, multiEntry: false }],
          records: [{ key: "marker", value: { at: new Date(0), bytes } }],
        },
        {
          name: "people",
          keyPath: ["last", "first"],
          autoIncrement: false,
          indexes: [],
          records: [],
        },
        {
          name: "log",
          keyPath: "id",
          autoIncrement: true,
          indexes: [],
          records: [{ value: { id: 1 } }],
        },
      ],
    },
  ],
  caches: [
    {
      name: "v1",
      entries: [
        {
          request: { url: "http://app.localhost/a", method: "GET", headers: [["accept", "*/*"]] },
          response: { status: 200, statusText: "OK", headers: [], body: bytes.buffer },
        },
        {
          request: { url: "http://app.localhost/b", method: "GET", headers: [] },
          response: { status: 204, statusText: "", headers: [], body: null },
        },
      ],
    },
  ],
};

test("accepts Web Storage entries and IndexedDB stores with any record value", () => {
  const parsed = v.parse(OriginDataSchema, data);
  expect(parsed).toEqual(data);
  // Record values pass through untouched, so Date and typed arrays keep their type.
  const [kv] = (parsed as OriginData).indexedDB[0]?.stores ?? [];
  const value = kv?.records[0]?.value as { at: unknown; bytes: unknown };
  expect(value.at).toBeInstanceOf(Date);
  expect(value.bytes).toBe(bytes);
});

test("rejects storage values that are not strings", () => {
  expect(v.is(OriginDataSchema, { ...data, localStorage: { count: 1 } })).toBe(false);
  expect(v.is(OriginDataSchema, { ...data, sessionStorage: undefined })).toBe(false);
  for (const [what, storage] of Object.entries({
    null: null,
    empty: [],
    array: ["a"],
    map: new Map([["a", "b"]]),
    text: "a=b",
  })) {
    expect(v.is(OriginDataSchema, { ...data, localStorage: storage }), what).toBe(false);
  }
});

test("keeps every Web Storage key, even those named like an object's own properties", () => {
  // Built with defineProperty-like semantics, as structured clone builds a received object.
  const entries = Object.fromEntries([
    ["__proto__", "a"],
    ["constructor", "b"],
    ["prototype", "c"],
    ["", ""],
    ["ключ 🔑", "värde \u{1F600}"],
  ]);
  const parsed = v.parse(OriginDataSchema, {
    ...data,
    localStorage: entries,
    sessionStorage: entries,
  });
  expect(Object.entries(parsed.localStorage)).toEqual(Object.entries(entries));
  expect(Object.entries(parsed.sessionStorage)).toEqual(Object.entries(entries));
});

test("rejects a database without a positive integer version or a store without its shape", () => {
  const database = data.indexedDB[0];
  for (const version of [0, 1.5, "1"]) {
    expect(v.is(OriginDataSchema, { ...data, indexedDB: [{ ...database, version }] })).toBe(false);
  }
  const store = { name: "kv", keyPath: 4, autoIncrement: false, records: [] };
  expect(v.is(OriginDataSchema, { ...data, indexedDB: [{ ...database, stores: [store] }] })).toBe(
    false,
  );
  const unvalued = { name: "kv", keyPath: null, autoIncrement: false, records: [{ key: 1 }] };
  expect(
    v.is(OriginDataSchema, { ...data, indexedDB: [{ ...database, stores: [unvalued] }] }),
  ).toBe(false);
});

test("keeps each cache's entries, bodies as ArrayBuffers, and defaults to no cache at all", () => {
  const parsed = v.parse(OriginDataSchema, data);
  expect(parsed.caches[0]?.entries[0]?.response.body).toBe(bytes.buffer);
  const { caches: _caches, ...older } = data;
  expect(v.parse(OriginDataSchema, older).caches).toEqual([]);
  const [entry] = data.caches[0]?.entries ?? [];
  const opaque = { ...entry, response: { ...entry?.response, status: 0 } };
  expect(v.is(OriginDataSchema, { ...data, caches: [{ name: "v1", entries: [opaque] }] })).toBe(
    false,
  );
});

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
          records: [{ key: "marker", value: { at: new Date(0), bytes } }],
        },
        { name: "people", keyPath: ["last", "first"], autoIncrement: false, records: [] },
        { name: "log", keyPath: "id", autoIncrement: true, records: [{ value: { id: 1 } }] },
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

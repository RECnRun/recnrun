import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { OriginCommandSchema, OriginReplySchema } from "@/messaging/origin-protocol";

const payload = { localStorage: { theme: "dark" }, sessionStorage: {}, indexedDB: [] };
const restore = { type: "restore", operationId: "op-1", generation: 2, payload };
const counts = { localStorage: 1, sessionStorage: 0, databases: 0, records: 0 };

test("a restore command names its operation and carries the origin's data", () => {
  expect(v.is(OriginCommandSchema, restore)).toBe(true);
  for (const bad of [
    { ...restore, type: "replace" },
    { ...restore, operationId: "" },
    { ...restore, generation: -1 },
    { ...restore, generation: 0.5 },
    { ...restore, payload: { ...payload, localStorage: { theme: 1 } } },
    { ...restore, payload: undefined },
  ]) {
    expect(v.is(OriginCommandSchema, bad), JSON.stringify(bad)).toBe(false);
  }
});

test("the agent answers restored with counts, or failed with a short reason", () => {
  const restored = { type: "restored", operationId: "op-1", generation: 2, counts };
  const failed = {
    type: "failed",
    operationId: "op-1",
    generation: 2,
    error: "check: OriginNotEmpty",
  };
  expect(v.is(OriginReplySchema, restored)).toBe(true);
  expect(v.is(OriginReplySchema, failed)).toBe(true);
  for (const bad of [
    { ...restored, type: "done" },
    { ...restored, counts: { ...counts, records: -1 } },
    { ...restored, operationId: undefined },
    { ...failed, error: "x".repeat(201) },
    { ...failed, generation: "2" },
  ]) {
    expect(v.is(OriginReplySchema, bad), JSON.stringify(bad)).toBe(false);
  }
});

test("a capture command names its operation and a chunk size, 500 records unless it says", () => {
  const capture = { type: "capture", operationId: "op-1", generation: 2 };
  expect(v.parse(OriginCommandSchema, capture)).toEqual({ ...capture, chunk: 500 });
  expect(v.parse(OriginCommandSchema, { ...capture, chunk: 2 })).toEqual({ ...capture, chunk: 2 });
  for (const chunk of [0, 1.5, 10_001]) {
    expect(v.is(OriginCommandSchema, { ...capture, chunk }), String(chunk)).toBe(false);
  }
});

test("a capture answers each database's schema, its records, and the counts", () => {
  const operation = { operationId: "op-1", generation: 2 };
  const store = { name: "kv", keyPath: null, autoIncrement: false, indexes: [], records: [] };
  const database = { name: "app", version: 3, stores: [store] };
  const records = { database: "app", store: "kv", records: [{ key: 1, value: new Date(0) }] };
  const replies = [
    { type: "capture-started", ...operation, probe: new Date(0) },
    { type: "capture-database", ...operation, database },
    { type: "capture-records", ...operation, ...records },
    { type: "captured", ...operation, counts: { databases: 1, records: 1 } },
  ];
  for (const reply of replies) expect(v.is(OriginReplySchema, reply), reply.type).toBe(true);
  for (const bad of [
    { type: "capture-database", ...operation, database: { ...database, version: 0 } },
    { type: "capture-records", ...operation, ...records, store: undefined },
    { type: "capture-records", ...operation, ...records, records: [{ key: 1 }, 2] },
    { type: "captured", ...operation, counts: { databases: 1 } },
  ]) {
    expect(v.is(OriginReplySchema, bad), JSON.stringify(bad)).toBe(false);
  }
});

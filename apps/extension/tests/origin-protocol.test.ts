import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { OriginReplySchema, OriginRestoreCommandSchema } from "@/messaging/origin-protocol";

const payload = { localStorage: { theme: "dark" }, sessionStorage: {}, indexedDB: [] };
const restore = { type: "restore", operationId: "op-1", generation: 2, payload };
const counts = { localStorage: 1, sessionStorage: 0, databases: 0, records: 0 };

test("a restore command names its operation and carries the origin's data", () => {
  expect(v.is(OriginRestoreCommandSchema, restore)).toBe(true);
  for (const bad of [
    { ...restore, type: "capture" },
    { ...restore, operationId: "" },
    { ...restore, generation: -1 },
    { ...restore, generation: 0.5 },
    { ...restore, payload: { ...payload, localStorage: { theme: 1 } } },
    { ...restore, payload: undefined },
  ]) {
    expect(v.is(OriginRestoreCommandSchema, bad), JSON.stringify(bad)).toBe(false);
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

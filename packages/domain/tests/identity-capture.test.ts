import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  IDENTITY_CAPTURE_VERSION,
  IdentityCaptureSchema,
  IdentityDataSchema,
  restorableData,
} from "../src/index.ts";
import type { IdentityCapture } from "../src/index.ts";
import { sampleCapture } from "./fixtures.ts";

const valid = (capture: unknown) => v.is(IdentityCaptureSchema, capture);

/** The sample's one origin, its database, and its cache, which every sample has. */
function partsOf(capture: IdentityCapture) {
  const [origin] = capture.origins;
  const [database] = origin?.indexedDB ?? [];
  const [cache] = origin?.caches ?? [];
  if (!origin || !database || !cache) throw new Error("The sample lost its origin data.");
  return { origin, database, cache };
}

test("accepts a complete capture with its schema, cookies, Web Storage, caches, and unsupported items", () => {
  const capture = sampleCapture();
  const parsed = v.parse(IdentityCaptureSchema, capture);
  expect(parsed).toEqual(capture);
  expect(parsed.formatVersion).toBe(IDENTITY_CAPTURE_VERSION);
  const { database, cache } = partsOf(parsed);
  expect(database.stores[0]?.indexes).toEqual([
    { name: "byName", keyPath: "name", unique: true, multiEntry: false },
    { name: "byTag", keyPath: "tags", unique: false, multiEntry: true },
  ]);
  // Values stay `unknown` and pass through by reference, so structured types keep their type.
  const source = partsOf(capture).database.stores[1]?.records[0]?.value;
  expect(database.stores[1]?.records[0]?.value).toBe(source);
  expect(cache.entries[0]?.response.body).toBeInstanceOf(ArrayBuffer);
});

test("accepts a capture in progress, without an end time, and a failed one with its error", () => {
  const { endedAt: _, ...started } = sampleCapture();
  expect(valid({ ...started, status: "in-progress", origins: [] })).toBe(true);
  const failed = {
    ...sampleCapture(),
    status: "failed",
    error: "indexedDB: AbortError",
    adapters: [{ adapter: "indexedDB", status: "failed", error: "AbortError" }],
  };
  expect(valid(failed)).toBe(true);
});

test("defaults a store's indexes to none, so a capture without them still reads", () => {
  const capture = sampleCapture();
  const database = capture.origins[0]?.indexedDB[0];
  const { indexes: _, ...bare } = database?.stores[0] ?? {};
  const origin = { ...capture.origins[0], indexedDB: [{ ...database, stores: [bare] }] };
  const parsed = v.parse(IdentityCaptureSchema, { ...capture, origins: [origin] });
  expect(parsed.origins[0]?.indexedDB[0]?.stores[0]?.indexes).toEqual([]);
});

test("rejects another format version, a browser-internal target, or a missing identity", () => {
  const capture = sampleCapture();
  expect(valid({ ...capture, formatVersion: 2 })).toBe(false);
  expect(valid({ ...capture, url: "chrome://settings/" })).toBe(false);
  expect(valid({ ...capture, identityId: "" })).toBe(false);
  expect(valid({ ...capture, id: undefined })).toBe(false);
});

test("rejects a complete capture that has no end, a failed adapter, an error, or lacks its target's origin", () => {
  const capture = sampleCapture();
  const { endedAt: _, ...unended } = capture;
  expect(valid(unended)).toBe(false);
  expect(valid({ ...capture, endedAt: capture.startedAt - 1 })).toBe(false);
  expect(valid({ ...capture, error: "late" })).toBe(false);
  const failedAdapter = { adapter: "cookies", status: "failed", error: "NotAllowed" };
  expect(valid({ ...capture, adapters: [capture.adapters[0], failedAdapter] })).toBe(false);
  expect(valid({ ...capture, url: "http://other.localhost:5192/" })).toBe(false);
  expect(valid({ ...capture, url: "http://app.localhost:51920/" })).toBe(false);
  expect(valid({ ...capture, url: "http://app.localhost:5192?tab=1" })).toBe(true);
});

test("rejects a failed capture without its error, and one in progress that has ended", () => {
  const capture = sampleCapture();
  expect(valid({ ...capture, status: "failed" })).toBe(false);
  expect(valid({ ...capture, status: "in-progress" })).toBe(false);
});

test("rejects repeated origins, adapters, or value types", () => {
  const capture = sampleCapture();
  const [origin] = capture.origins;
  expect(valid({ ...capture, origins: [origin, origin] })).toBe(false);
  const [adapter] = capture.adapters;
  expect(valid({ ...capture, adapters: [adapter, adapter] })).toBe(false);
  expect(valid({ ...capture, valueTypes: ["Date", "Date"] })).toBe(false);
  expect(valid({ ...capture, valueTypes: ["Function"] })).toBe(false);
});

test("rejects an origin with a path, an index without a key path, and a malformed cache entry", () => {
  const capture = sampleCapture();
  const origin = capture.origins[0] as IdentityCapture["origins"][number];
  const withOrigin = (patch: object) => ({ ...capture, origins: [{ ...origin, ...patch }] });
  expect(valid(withOrigin({ origin: "http://app.localhost:5192/app" }))).toBe(false);
  expect(valid(withOrigin({ origin: "file://" }))).toBe(false);

  const database = origin.indexedDB[0] as IdentityCapture["origins"][number]["indexedDB"][number];
  const store = {
    ...database.stores[0],
    indexes: [{ name: "x", unique: false, multiEntry: false }],
  };
  expect(valid(withOrigin({ indexedDB: [{ ...database, stores: [store] }] }))).toBe(false);

  const entry = origin.caches[0]?.entries[0];
  const badStatus = { ...entry, response: { ...entry?.response, status: 1_000 } };
  expect(valid(withOrigin({ caches: [{ name: "v1", entries: [badStatus] }] }))).toBe(false);
  const badHeaders = { ...entry, request: { ...entry?.request, headers: [["accept"]] } };
  expect(valid(withOrigin({ caches: [{ name: "v1", entries: [badHeaders] }] }))).toBe(false);
  // A Response can only be rebuilt with a status from 200 to 599, so an opaque one is never kept.
  const opaque = { ...entry, response: { ...entry?.response, status: 0 } };
  expect(valid(withOrigin({ caches: [{ name: "v1", entries: [opaque] }] }))).toBe(false);
  const typed = { ...entry, response: { ...entry?.response, body: new Uint8Array([1]) } };
  expect(valid(withOrigin({ caches: [{ name: "v1", entries: [typed] }] }))).toBe(false);
});

test("rejects an unsupported item without its adapter, or a reason long enough to carry a value", () => {
  const capture = sampleCapture();
  const item = { adapter: "cacheStorage", item: "v1 /opaque", reason: "Opaque response" };
  expect(valid({ ...capture, unsupported: [{ ...item, adapter: "memory" }] })).toBe(false);
  expect(valid({ ...capture, unsupported: [{ ...item, reason: "x".repeat(201) }] })).toBe(false);
});

test("rejects a declared cookie host that is not a bare host name", () => {
  const capture = sampleCapture();
  for (const host of ["", "https://sso.localhost", "sso.localhost/path"]) {
    expect(valid({ ...capture, capabilities: { cookieHosts: [host] } }), host).toBe(false);
  }
});

test("restores a capture's cookies and its target origin's site data, caches included", () => {
  const capture = sampleCapture();
  const other = { ...partsOf(capture).origin, origin: "http://other.localhost:5192" };
  const { origin } = partsOf(capture);
  const data = restorableData({ ...capture, origins: [other, origin] });
  expect(data).toEqual({
    cookies: capture.cookies,
    site: {
      localStorage: origin.localStorage,
      sessionStorage: origin.sessionStorage,
      indexedDB: origin.indexedDB,
      caches: origin.caches,
    },
  });
  expect(v.is(IdentityDataSchema, data)).toBe(true);
  expect(() => restorableData({ ...capture, origins: [other] })).toThrow(/target's origin/);
});

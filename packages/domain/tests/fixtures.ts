import type { IdentityCapture, Snapshot } from "../src/index.ts";

/** A small snapshot with two recordings, stored oldest first. */
export function sampleSnapshot(): Snapshot {
  return {
    schemaVersion: 1,
    recordings: [
      {
        id: "rec-login",
        name: "Log in as admin",
        startUrl: "http://localhost:3000/login",
        createdAt: "2026-10-01T09:30:00.000Z",
        durationMs: 12_400,
        eventCount: 7,
      },
      {
        id: "rec-checkout",
        name: "Checkout with saved card",
        startUrl: "https://staging.shop.example/cart",
        createdAt: "2026-10-02T14:05:00.000Z",
        durationMs: 95_000,
        eventCount: 31,
      },
    ],
  };
}

/** A complete capture of one origin: an indexed store, an out-of-line one, an empty one, a cache. */
export function sampleCapture(): IdentityCapture {
  const origin = "http://app.localhost:5192";
  const json = "application/json";
  return {
    formatVersion: 1,
    id: "capture-1",
    identityId: "identity-a",
    url: `${origin}/app/`,
    capabilities: { cookieHosts: [] },
    status: "complete",
    startedAt: 1_000,
    endedAt: 1_250,
    adapters: [
      { adapter: "indexedDB", status: "captured" },
      { adapter: "cookies", status: "skipped" },
    ],
    valueTypes: ["Object", "Array", "Date", "Map", "TypedArray"],
    cookies: [
      { name: "sid", value: "abc", path: "/", secure: false, httpOnly: true, sameSite: "lax" },
    ],
    origins: [
      {
        origin,
        localStorage: { theme: "dark" },
        sessionStorage: {},
        indexedDB: [
          {
            name: "shop",
            version: 3,
            stores: [
              {
                name: "products",
                keyPath: "sku",
                autoIncrement: false,
                indexes: [
                  { name: "byName", keyPath: "name", unique: true, multiEntry: false },
                  { name: "byTag", keyPath: "tags", unique: false, multiEntry: true },
                ],
                records: [{ value: { sku: "p1", name: "Pen", tags: ["red", "office"] } }],
              },
              {
                name: "orders",
                keyPath: null,
                autoIncrement: true,
                indexes: [],
                records: [{ key: 1, value: { at: new Date(0), lines: new Map([["p1", 2]]) } }],
              },
              { name: "empty", keyPath: null, autoIncrement: false, indexes: [], records: [] },
            ],
          },
        ],
        caches: [
          {
            name: "v1",
            entries: [
              {
                request: {
                  url: `${origin}/app/data.json`,
                  method: "GET",
                  headers: [["accept", json]],
                },
                response: {
                  status: 200,
                  statusText: "OK",
                  headers: [["content-type", json]],
                  body: new Uint8Array([123, 125]),
                },
              },
            ],
          },
        ],
      },
    ],
    unsupported: [
      { adapter: "cacheStorage", item: "v1 http://cdn.localhost/x.js", reason: "Opaque response" },
    ],
  };
}

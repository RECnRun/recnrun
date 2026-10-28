import type { OriginData } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { UnsupportedEntry } from "@/messaging/origin-protocol";
import { readCaches, writeCaches } from "@/origin/cache-storage";
import { restoreOrigin } from "@/origin/restore";
import { clearCaches, clearDatabases, memoryStorage } from "./origin-storage";

type Cache = OriginData["caches"][number];

/** Reads `storage` the way the agent does, keeping every message it would send. */
async function captured(storage: CacheStorage | undefined) {
  const sent: { cache: Cache; unsupported: UnsupportedEntry[] }[] = [];
  const counts = await readCaches(storage, (cache, unsupported) =>
    sent.push({ cache, unsupported }),
  );
  return { counts, sent };
}

/** Each cache's entries as a page reads them back: request, then the response it gets. */
async function pageView() {
  const view: Record<string, unknown[]> = {};
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    view[name] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      view[name].push({
        url: request.url,
        headers: [...request.headers],
        status: response?.status,
        statusText: response?.statusText,
        responseHeaders: [...(response?.headers ?? [])],
        body: await response?.text(),
      });
    }
  }
  return view;
}

beforeEach(async () => {
  await clearCaches();
  await clearDatabases();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearCaches();
});

test("every cache and entry comes back as the page reads it, in order, Vary included", async () => {
  const pages = await caches.open("pages");
  const vary = { headers: { "x-variant": "b" } };
  await pages.put(
    new Request("/b", vary),
    new Response("b", { headers: { vary: "x-variant", "x-kind": "page" } }),
  );
  await pages.put("/a?token=1", new Response("a", { status: 201, statusText: "Made" }));
  await pages.put("/empty", new Response(null, { status: 204 }));
  await (await caches.open("api")).put("/x", new Response(new Uint8Array([0, 255])));
  const before = await pageView();
  const { counts, sent } = await captured(caches);
  expect(counts).toEqual({ caches: 2, cacheEntries: 4 });
  expect(sent.map(({ cache }) => cache.name)).toEqual(["pages", "api"]);
  expect(sent.flatMap(({ unsupported }) => unsupported)).toEqual([]);
  expect(sent[0]?.cache.entries[2]?.response.body).toBeNull();

  await clearCaches();
  const restored = await restoreOrigin(
    { localStorage: memoryStorage(), sessionStorage: memoryStorage(), indexedDB, caches },
    { localStorage: {}, sessionStorage: {}, indexedDB: [], caches: sent.map(({ cache }) => cache) },
  );
  expect(restored).toMatchObject({ caches: 2, cacheEntries: 4 });
  expect(await pageView()).toEqual(before);
  await expect(caches.match(new Request("/b", vary))).resolves.toBeDefined();
  const other = new Request("/b", { headers: { "x-variant": "c" } });
  await expect(caches.match(other)).resolves.toBeUndefined();
});

/** Cache Storage holding one cache whose entries `match` answers with `responses`, in order. */
function fakeStorage(urls: string[], responses: (Partial<Response> | undefined)[]) {
  const cache = {
    keys: async () => urls.map((url) => new Request(url)),
    match: vi.fn(async (request: Request) => responses[urls.indexOf(request.url)]),
  };
  return { keys: async () => ["cdn"], open: async () => cache } as unknown as CacheStorage;
}

test("opaque entries are named without their query, and never sent", async () => {
  const urls = [
    "https://cdn.test/lib.js?key=s3cret",
    "https://cdn.test/go",
    "https://cdn.test/gone",
  ];
  const responses = [{ type: "opaque" as const }, { type: "opaqueredirect" as const }, undefined];
  const { counts, sent } = await captured(fakeStorage(urls, responses));
  expect(counts).toEqual({ caches: 1, cacheEntries: 0 });
  expect(sent).toEqual([
    {
      cache: { name: "cdn", entries: [] },
      unsupported: [
        { item: "cdn GET https://cdn.test/lib.js", reason: expect.stringMatching(/opaque/) },
        { item: "cdn GET https://cdn.test/go", reason: expect.stringMatching(/opaque/) },
      ],
    },
  ]);
  expect(JSON.stringify(sent)).not.toMatch(/s3cret/);
});

test("without Cache Storage nothing is read, and only an empty list can be written", async () => {
  await expect(captured(undefined)).resolves.toEqual({
    counts: { caches: 0, cacheEntries: 0 },
    sent: [],
  });
  await expect(writeCaches(undefined, [])).resolves.toBe(0);
  await expect(writeCaches(undefined, [{ name: "v1", entries: [] }])).rejects.toMatchObject({
    name: "SecurityError",
  });
});

test("a restore refuses an origin that already holds a cache", async () => {
  await caches.open("left");
  const stores = { localStorage: memoryStorage(), sessionStorage: memoryStorage(), indexedDB };
  await expect(
    restoreOrigin(
      { ...stores, caches },
      { localStorage: {}, sessionStorage: {}, indexedDB: [], caches: [] },
    ),
  ).rejects.toMatchObject({ message: "check: OriginNotEmpty" });
});

test("an entry the cache refuses fails the restore at its step", async () => {
  const entry = {
    request: { url: "/vary", method: "GET", headers: [] },
    response: { status: 200, statusText: "", headers: [["vary", "*"]], body: null },
  } satisfies Cache["entries"][number];
  await expect(writeCaches(caches, [{ name: "v1", entries: [entry] }])).rejects.toMatchObject({
    name: "TypeError",
  });
});

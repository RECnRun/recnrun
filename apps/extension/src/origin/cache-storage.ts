import type { OriginData } from "@recnrun/domain";
import type { UnsupportedEntry } from "@/messaging/origin-protocol";

type Cache = OriginData["caches"][number];
type Entry = Cache["entries"][number];

/** Where a capture sends each cache, with the entries it could not keep named apart. */
export type CacheSink = (cache: Cache, unsupported: UnsupportedEntry[]) => void;

/** Statuses whose `Response` must have a null body; an empty one makes the constructor throw. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** A `Response` takes a status of 200 to 599 only, and an opaque one reports 0 and hides the rest. */
const OPAQUE_REASON =
  "An opaque response hides its status, headers, and body, so no Response can rebuild it.";

/** Names an entry by cache, method, and URL without its query, which may hold a token. */
function itemOf(cache: string, request: Request): string {
  const { origin, pathname } = new URL(request.url);
  return `${cache} ${request.method} ${origin}${pathname}`;
}

async function entryOf(request: Request, response: Response): Promise<Entry> {
  const { status, statusText, url, redirected } = response;
  const body = NULL_BODY.has(status) ? null : await response.arrayBuffer();
  const type = response.type === "basic" || response.type === "cors" ? response.type : "default";
  return {
    request: { url: request.url, method: request.method, headers: [...request.headers] },
    response: { status, statusText, headers: [...response.headers], body, type, url, redirected },
  };
}

/** Reads one cache's entries in its own order; an opaque one goes to `unsupported`. */
async function readCache(storage: CacheStorage, name: string, send: CacheSink): Promise<number> {
  const cache = await storage.open(name);
  const entries: Entry[] = [];
  const unsupported: UnsupportedEntry[] = [];
  for (const request of await cache.keys()) {
    // The stored request carries its own Vary headers, so it matches its own entry.
    const response = await cache.match(request);
    if (!response) continue;
    if (response.type === "opaque" || response.type === "opaqueredirect") {
      unsupported.push({ item: itemOf(name, request), reason: OPAQUE_REASON });
    } else entries.push(await entryOf(request, response));
  }
  send({ name, entries }, unsupported);
  return entries.length;
}

/** Sends every cache of the origin to `send`; an insecure context has no Cache Storage at all. */
export async function readCaches(storage: CacheStorage | undefined, send: CacheSink) {
  if (!storage) return { caches: 0, cacheEntries: 0 };
  const names = await storage.keys();
  let cacheEntries = 0;
  for (const name of names) cacheEntries += await readCache(storage, name, send);
  return { caches: names.length, cacheEntries };
}

/** How many caches the origin already holds. */
export async function cacheCount(storage: CacheStorage | undefined): Promise<number> {
  return storage ? (await storage.keys()).length : 0;
}

/** Puts every entry back in its cache, in the captured order, and counts them. */
export async function writeCaches(
  storage: CacheStorage | undefined,
  caches: OriginData["caches"],
): Promise<number> {
  if (caches.length === 0) return 0;
  if (!storage) throw new DOMException("This context has no Cache Storage.", "SecurityError");
  let count = 0;
  for (const { name, entries } of caches) {
    const cache = await storage.open(name);
    for (const { request, response } of entries) {
      const { url, method, headers } = request;
      const { body, status, statusText, headers: kept } = response;
      // The guards drop forbidden headers, such as Set-Cookie, silently.
      const rebuilt = new Response(body, { status, statusText, headers: kept });
      await cache.put(new Request(url, { method, headers }), rebuilt);
      count += 1;
    }
  }
  return count;
}

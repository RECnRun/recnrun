import type { OriginData } from "@recnrun/domain";
import type { UnsupportedEntry } from "@/messaging/origin-protocol";
import { refetch } from "@/origin/cache-refetch";

type Cache = OriginData["caches"][number];
type Entry = Cache["entries"][number];

/** Where a capture sends each cache, with the entries it could not keep named apart. */
export type CacheSink = (cache: Cache, unsupported: UnsupportedEntry[]) => void;

/** Statuses whose `Response` must have a null body; an empty one makes the constructor throw. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** A `Response` takes a status of 200 to 599 only, and an opaque one reports 0 and hides the rest. */
const OPAQUE_REASON =
  "An opaque response hides its status, headers, and body, so no Response can rebuild it.";

/** How many entries a restore fetches again at once. */
const REFETCHES_AT_ONCE = 6;

/** Names an entry by cache, method, and URL without its query, which may hold a token. */
function itemOf(cache: string, { url, method }: Pick<Request, "url" | "method">): string {
  const { origin, pathname } = new URL(url);
  return `${cache} ${method} ${origin}${pathname}`;
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

/** What a restore wrote, and the fetched entries it could only write as captured. */
export interface CachesWritten {
  entries: number;
  rebuilt: UnsupportedEntry[];
}

/** A fetched entry's fresh response, or, for a constructed one, nothing to fetch. */
const answerOf = (entry: Entry) =>
  entry.response.url === "" ? Promise.resolve(undefined) : refetch(entry);

/** The response an entry goes back with: its fresh one, or one built from the capture. */
function responseOf({ response }: Entry, answer: Response | string | undefined): Response {
  if (answer instanceof Response) return answer;
  const { body, status, statusText, headers } = response;
  return new Response(body, { status, statusText, headers });
}

/** Writes the entries in order: each fetched again, a few at a time, or as captured. */
async function writeCache(
  cache: globalThis.Cache,
  name: string,
  entries: Entry[],
  written: CachesWritten,
): Promise<void> {
  for (let start = 0; start < entries.length; start += REFETCHES_AT_ONCE) {
    const batch = entries.slice(start, start + REFETCHES_AT_ONCE);
    const answers = await Promise.all(batch.map(answerOf));
    for (const [at, entry] of batch.entries()) {
      const { url, method, headers } = entry.request;
      // The guards drop forbidden headers, such as Set-Cookie, silently.
      await cache.put(new Request(url, { method, headers }), responseOf(entry, answers[at]));
      const reason = answers[at];
      if (typeof reason === "string")
        written.rebuilt.push({ item: itemOf(name, entry.request), reason });
      written.entries += 1;
    }
  }
}

/** Puts every entry back in its cache, in the captured order, and counts them. */
export async function writeCaches(
  storage: CacheStorage | undefined,
  caches: OriginData["caches"],
): Promise<CachesWritten> {
  const written: CachesWritten = { entries: 0, rebuilt: [] };
  if (caches.length === 0) return written;
  if (!storage) throw new DOMException("This context has no Cache Storage.", "SecurityError");
  for (const { name, entries } of caches) {
    await writeCache(await storage.open(name), name, entries, written);
  }
  return written;
}

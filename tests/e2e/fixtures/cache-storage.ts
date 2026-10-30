import type { Page, Worker } from "@playwright/test";

const OTHER = "http://other.localhost:5192";

/** The size of the constructed binary entry, for the capture's timing. */
export const LARGE_BYTES = 4 * 1024 * 1024;

/**
 * Fills two caches the way an app does: fetched same-origin, redirected, Vary, 204, and
 * cross-site CORS responses; constructed ones with a custom status and a large binary body; and
 * the opaque and opaque-redirect responses no `Response` can rebuild.
 */
export const fillCaches = (page: Page) =>
  page.evaluate(
    async ({ other, large }) => {
      const pages = await caches.open("pages-v1");
      await pages.add("/cache/basic");
      await pages.put("/cache/redirect", await fetch("/cache/redirect"));
      const variant = { headers: { "x-variant": "a" } };
      await pages.put(new Request("/cache/vary", variant), await fetch("/cache/vary", variant));
      await pages.put("/cache/none", await fetch("/cache/none"));
      const made = new Uint8Array(256).map((_, at) => at);
      const init = { status: 299, statusText: "Made Up", headers: { "x-made": "1" } };
      await pages.put("/cache/made?token=t0k3n", new Response(made, init));
      const api = await caches.open("api-v1");
      await api.put(`${other}/cache/cors`, await fetch(`${other}/cache/cors`));
      await api.put(
        `${other}/cache/basic`,
        await fetch(`${other}/cache/basic`, { mode: "no-cors" }),
      );
      const manual = await fetch("/cache/redirect", { redirect: "manual" });
      await api.put("/cache/redirect?manual=1", manual);
      const bytes = new Uint8Array(large).map((_, at) => at % 251);
      await api.put("/cache/large", new Response(bytes, { headers: { "content-type": "x/bin" } }));
    },
    { other: OTHER, large: LARGE_BYTES },
  );

/** One entry as the page reads it back: its request, then every field of the response it gets. */
export interface CacheView {
  key: string;
  requestHeaders: [string, string][];
  type: string;
  url: string;
  redirected: boolean;
  status: number;
  statusText: string;
  headers: [string, string][];
  bytes: number;
  sha256: string;
}

/** Every cache in the page's order, each entry with its response, and the Vary lookups. */
export const cacheView = (page: Page) =>
  page.evaluate(async () => {
    const hex = (buffer: ArrayBuffer) =>
      Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const view: Record<string, CacheView[]> = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const entries: CacheView[] = [];
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (!response) continue;
        const body = await response.arrayBuffer();
        const { type, url, redirected, status, statusText } = response;
        entries.push({
          key: request.url,
          requestHeaders: [...request.headers],
          type,
          url,
          redirected,
          status,
          statusText,
          headers: [...response.headers],
          bytes: body.byteLength,
          sha256: hex(await crypto.subtle.digest("SHA-256", body)),
        });
      }
      view[name] = entries;
    }
    const vary = async (variant: string) =>
      (await caches.match(new Request("/cache/vary", { headers: { "x-variant": variant } }))) !==
      undefined;
    return { view, varyMatches: { a: await vary("a"), b: await vary("b") } };
  });

interface CaptureRow {
  identityId: string;
  status: string;
  adapters: { adapter: string; status: string }[];
  unsupported: { adapter: string; item: string; reason: string }[];
}

/** The published capture's adapter results and unsupported items, read from the extension's store. */
export const capturedReport = (serviceWorker: Worker, identityId: string) =>
  serviceWorker.evaluate(async (id) => {
    const opening = indexedDB.open("recnrun-identity-captures");
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.addEventListener("success", () => resolve(opening.result));
      opening.addEventListener("error", () => reject(opening.error));
    });
    const listing = connection.transaction("captures").objectStore("captures").getAll();
    const rows = await new Promise<CaptureRow[]>((resolve, reject) => {
      listing.addEventListener("success", () => resolve(listing.result as CaptureRow[]));
      listing.addEventListener("error", () => reject(listing.error));
    });
    connection.close();
    const row = rows.find(({ identityId, status }) => identityId === id && status === "complete");
    return { adapters: row?.adapters, unsupported: row?.unsupported };
  }, identityId);

// A module service worker scoped to the whole fixture; it only intercepts CACHED_PATH.
import { CACHE_NAME, CACHED_PATH, SOURCE_HEADER } from "./sw-cache.js";

function labelled(response, source) {
  const headers = new Headers(response.headers);
  headers.set(SOURCE_HEADER, source);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return labelled(cached, "cache");
  const response = await fetch(request);
  await cache.put(request, response.clone());
  return labelled(response, "network");
}

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname === CACHED_PATH) {
    event.respondWith(cacheFirst(event.request));
  }
});

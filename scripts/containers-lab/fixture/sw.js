// The control's service worker: it answers /sw-check itself, so a page it controls says "sw".
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname !== "/sw-check") return;
  event.respondWith(
    new Response('<p id="user">sw</p>', { headers: { "content-type": "text/html" } }),
  );
});

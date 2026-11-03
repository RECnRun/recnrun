// First statements: an authenticated request, a database, and a cache, before anything else runs.
// This file is valid both as a classic script and as a module, so every variant can load it.
const swRequest = fetch(
  `http://api.localhost:4601/me?from=${encodeURIComponent(location.pathname + location.search)}`,
  { credentials: "include" },
);
const swDatabase = indexedDB.open("fixture-sw");
const swCache = caches.open("fixture-sw");

const SHELL_CACHE = "fixture-shell-v1";
const SHELL = ["/offline.html", "/index.html", "/index.js", "/page.js"];

const swStarted = new Promise((resolve, reject) => {
  swDatabase.onsuccess = () => resolve(swDatabase.result.name);
  swDatabase.onerror = () => reject(swDatabase.error);
})
  .then((database) => Promise.all([swRequest, database, swCache]))
  .then(async ([response, database]) => ({
    realm: "service",
    script: location.pathname + location.search,
    user: (await response.json()).user,
    database,
    cache: "fixture-sw",
  }))
  .catch((error) => ({ realm: "service", error: `${error.name}: ${error.message}` }));

function note(name) {
  return fetch(`http://api.localhost:4601/__marker?name=${encodeURIComponent(name)}`, {
    credentials: "include",
  });
}

async function navigate(event) {
  try {
    return (await event.preloadResponse) ?? (await fetch(event.request));
  } catch {
    return (await caches.match("/offline.html")) ?? Response.error();
  }
}

async function cacheFirst(request) {
  return (await caches.match(request)) ?? fetch(request);
}

self.addEventListener("install", (event) => {
  const precache = swStarted
    .then(() => caches.open(SHELL_CACHE))
    .then((cache) => cache.addAll(SHELL));
  event.waitUntil(precache.then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  const preload = self.registration.navigationPreload?.enable();
  event.waitUntil(Promise.all([preload, self.clients.claim()]));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") event.respondWith(navigate(event));
  else if (request.method === "GET" && new URL(request.url).origin === location.origin) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("message", (event) => {
  event.waitUntil(swStarted.then((report) => event.source?.postMessage(report)));
});

self.addEventListener("push", (event) => event.waitUntil(note("sw:push")));
self.addEventListener("sync", (event) => event.waitUntil(note(`sw:sync:${event.tag}`)));

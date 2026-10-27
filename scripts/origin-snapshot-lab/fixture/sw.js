// The fixture's service worker: it serves navigations from a cached shell (as an app shell SW
// does), logs every navigation into sw-db, and with ?hold=1 keeps a connection to app-db.
const SHELL = "shell-v1";
const hold = new URL(self.location.href).searchParams.has("hold");
let held = null;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add("/__shell"))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function logNavigation(url) {
  return new Promise((resolve) => {
    const request = indexedDB.open("sw-db", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("log", { autoIncrement: true });
    request.onerror = () => resolve();
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("log", "readwrite");
      transaction.objectStore("log").add({ url, at: Date.now() });
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => resolve();
    };
  });
}

async function holdAppDb() {
  if (!hold || held) return;
  const names = (await indexedDB.databases()).map((info) => info.name);
  if (!names.includes("app-db")) return;
  const request = indexedDB.open("app-db");
  request.onsuccess = () => (held = request.result);
}

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.waitUntil(Promise.all([logNavigation(event.request.url), holdAppDb()]));
  event.respondWith(caches.match("/__shell").then((cached) => cached ?? fetch(event.request)));
});

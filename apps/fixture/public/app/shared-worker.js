// First statements: an authenticated request, a database, and a cache, before anything else runs.
// This file is valid both as a classic script and as a module, so it serves both worker types.
const sharedRequest = fetch(
  `http://api.localhost:4601/me?from=${encodeURIComponent(location.pathname + location.search)}`,
  { credentials: "include" },
);
const sharedDatabase = indexedDB.open("fixture-shared");
const sharedCache = caches.open("fixture-shared");

const sharedStarted = new Promise((resolve, reject) => {
  sharedDatabase.onsuccess = () => resolve(sharedDatabase.result.name);
  sharedDatabase.onerror = () => reject(sharedDatabase.error);
})
  .then((database) => Promise.all([sharedRequest, database, sharedCache]))
  .then(async ([response, database]) => ({
    realm: "shared",
    user: (await response.json()).user,
    database,
    cache: "fixture-shared",
  }))
  .catch((error) => ({ realm: "shared", error: `${error.name}: ${error.message}` }));

self.addEventListener("connect", (event) => {
  const [port] = event.ports;
  void sharedStarted.then((report) => port.postMessage(report));
});

// First statements: an authenticated request, a database, and a cache, before anything else runs.
// This file is valid both as a classic script and as a module, so it serves both worker types.
const firstRequest = fetch(
  `http://api.localhost:4601/me?from=${encodeURIComponent(location.pathname + location.search)}`,
  { credentials: "include" },
);
const firstDatabase = indexedDB.open("fixture-dedicated");
const firstCache = caches.open("fixture-dedicated");

function databaseOpened(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result.name);
    request.onerror = () => reject(request.error);
  });
}

const started = Promise.all([firstRequest, databaseOpened(firstDatabase), firstCache])
  .then(([response, database]) => response.json().then(({ user }) => ({ user, database })))
  .then(
    (result) => ({ realm: "dedicated", ...result, cache: "fixture-dedicated" }),
    (error) => ({ realm: "dedicated", error: `${error.name}: ${error.message}` }),
  );

void started.then((report) => postMessage(report));

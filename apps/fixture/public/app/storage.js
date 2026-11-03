import { attempt, currentUser, firstPaint, marker, show } from "./page.js";

await marker("storage:start");

const user = (await currentUser()) ?? "anonymous";

function putInDatabase(value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("fixture-page", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("kv", "readwrite");
      transaction.objectStore("kv").put(value, "user");
      transaction.oncomplete = () => resolve(`${database.name}: ${value}`);
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

async function putInCache(value) {
  const cache = await caches.open("fixture-page");
  await cache.put("/fixture-user", new Response(value));
  return (await cache.match("/fixture-user")).text();
}

async function writeOriginPrivateFile(value) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle("fixture-user.txt", { create: true });
  const writable = await handle.createWritable();
  await writable.write(value);
  await writable.close();
  return (await handle.getFile()).text();
}

const report = {
  user,
  localStorage: await attempt(() => {
    localStorage.setItem("fixture:user", user);
    return localStorage.getItem("fixture:user");
  }),
  sessionStorage: await attempt(() => {
    sessionStorage.setItem("fixture:user", user);
    return sessionStorage.getItem("fixture:user");
  }),
  documentCookie: await attempt(() => {
    document.cookie = `fixture_user=${encodeURIComponent(user)}; Path=/; SameSite=Lax`;
    return document.cookie;
  }),
  indexedDB: await attempt(() => putInDatabase(user)),
  cacheStorage: await attempt(() => putInCache(user)),
  opfs: await attempt(() => writeOriginPrivateFile(user)),
  webLocks: await attempt(() => navigator.locks.request("fixture-lock", () => "held")),
  broadcastChannel: await attempt(() => {
    const channel = new BroadcastChannel("fixture-channel");
    channel.postMessage({ user });
    channel.close();
    return "posted";
  }),
};

show("report", report);
await firstPaint("storage");

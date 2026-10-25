// Marker writes and reads for each page API; the harness calls them through window.apis.
const request = (operation) =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });

async function database() {
  const opening = indexedDB.open("markers", 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("kv");
  return request(opening);
}

async function idbWrite(marker) {
  const db = await database();
  await request(db.transaction("kv", "readwrite").objectStore("kv").put(marker, "marker"));
  db.close();
}

async function idbRead() {
  const db = await database();
  const value = await request(db.transaction("kv").objectStore("kv").get("marker"));
  db.close();
  return value ?? null;
}

async function opfs(marker) {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle("marker", { create: true });
  if (marker !== undefined) {
    const writable = await file.createWritable();
    await writable.write(marker);
    await writable.close();
  }
  return (await (await file.getFile()).text()) || null;
}

const workers = {};

function workerOf(kind) {
  if (kind === "shared") workers[kind] ??= new SharedWorker("/worker.js", "lab");
  else
    workers[kind] ??= new Worker("/worker.js", kind === "module" ? { type: "module" } : undefined);
  return workers[kind];
}

const cookieMarker = () => /(?:^|; )marker=([^;]*)/.exec(document.cookie)?.[1] ?? null;
const received = [];
const storageEvents = [];

window.apis = {
  async write(marker) {
    localStorage.setItem("marker", marker);
    sessionStorage.setItem("marker", marker);
    document.cookie = `marker=${marker}; Path=/`;
    await idbWrite(marker);
    await (await caches.open("markers")).put("/marker", new Response(marker));
    await opfs(marker);
    // Held until the page goes away.
    void navigator.locks.request("held", { ifAvailable: true }, (lock) =>
      lock ? new Promise(() => {}) : null,
    );
    return true;
  },
  async read() {
    const lock = await navigator.locks.request("probe", { ifAvailable: true }, (held) =>
      Boolean(held),
    );
    return {
      localStorage: localStorage.getItem("marker"),
      localKeys: Object.keys(localStorage),
      sessionStorage: sessionStorage.getItem("marker"),
      cookie: cookieMarker(),
      indexedDB: await idbRead(),
      databases: (await indexedDB.databases()).map(({ name }) => name),
      cache: (await (await caches.match("/marker"))?.text()) ?? null,
      cacheKeys: await caches.keys(),
      opfs: await opfs(),
      heldLocks: (await navigator.locks.query()).held.map(({ name }) => name),
      probeLock: lock,
      cookieStore: "cookieStore" in window,
    };
  },
  listen() {
    const channel = new BroadcastChannel("logout");
    channel.onmessage = ({ data }) => received.push(data);
    window.addEventListener("storage", ({ key, newValue }) =>
      storageEvents.push({ key, newValue }),
    );
  },
  broadcast(message) {
    new BroadcastChannel("logout").postMessage(message);
    localStorage.setItem("signal", message);
  },
  heard: () => ({ received, storageEvents }),
  /** Asks a worker of `kind` (dedicated, module, shared) to write or read its marker. */
  worker(kind, message) {
    const worker = workerOf(kind);
    const port = worker.port ?? worker;
    return new Promise((resolve) => {
      port.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => resolve({ error: event.message ?? "error" });
      port.postMessage(message);
    });
  },
  /** A fresh same-origin realm, created and read synchronously. */
  freshRealm() {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const keys = Object.keys(frame.contentWindow.localStorage);
    const native = /\[native code\]/.test(frame.contentWindow.Storage.prototype.getItem.toString());
    frame.remove();
    return { keys, native };
  },
};

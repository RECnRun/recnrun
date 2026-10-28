// Page scripts are plain functions serialized with toString(), so they must not close over imports.

/** What `/inspect` reads, one field per storage kind. */
export interface Inspected {
  cookies: Record<string, string>;
  serverCookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  databases: string[];
  idbRecord: string | null;
  caches: string[];
  cacheEntry: string | null;
  registrations: string[];
  controller: string | null;
}

interface FixtureWindow {
  __sentinelDone?: boolean;
  __sentinelError?: string;
  __inspected?: Inspected;
}

/** Runs in the page: writes `tag` into every client storage kind and registers the worker. */
async function writeSentinels(tag: string): Promise<void> {
  const state = window as FixtureWindow;
  try {
    document.cookie = `sentinel_js=${tag}; path=/; SameSite=Lax`;
    localStorage.setItem("sentinel", tag);
    sessionStorage.setItem("sentinel", tag);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("sentinel", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
      open.onsuccess = () => {
        const db = open.result;
        const write = db.transaction("kv", "readwrite");
        write.objectStore("kv").put(tag, "sentinel");
        write.oncomplete = () => {
          db.close();
          resolve();
        };
        write.onerror = () => reject(write.error ?? new Error("IndexedDB write failed"));
      };
    });
    await (await caches.open("sentinel")).put("/sentinel-entry", new Response(tag));
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    state.__sentinelDone = true;
  } catch (error) {
    state.__sentinelError = String(error);
  }
}

/** Runs in the page: reads every storage kind without creating any, then reports to the log. */
async function inspectStorage(serverCookies: Record<string, string>, run: string): Promise<void> {
  const entries = (storage: Storage) =>
    Object.fromEntries(Object.keys(storage).map((key) => [key, storage.getItem(key) ?? ""]));
  const readRecord = () =>
    new Promise<string | null>((resolve, reject) => {
      const open = indexedDB.open("sentinel");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("kv")) {
          db.close();
          resolve(null);
          return;
        }
        const read = db.transaction("kv").objectStore("kv").get("sentinel");
        read.onsuccess = () => {
          db.close();
          resolve(typeof read.result === "string" ? read.result : null);
        };
        read.onerror = () => reject(read.error ?? new Error("IndexedDB read failed"));
      };
    });
  const databases = (await indexedDB.databases()).map(({ name }) => name ?? "");
  const cacheNames = await caches.keys();
  const entry = cacheNames.includes("sentinel")
    ? await (await caches.open("sentinel")).match("/sentinel-entry")
    : undefined;
  const cookies = document.cookie
    .split("; ")
    .filter(Boolean)
    .map((pair) => pair.split("="));
  const result: Inspected = {
    cookies: Object.fromEntries(cookies.map(([name, ...value]) => [name, value.join("=")])),
    serverCookies,
    localStorage: entries(localStorage),
    sessionStorage: entries(sessionStorage),
    databases,
    idbRecord: databases.includes("sentinel") ? await readRecord() : null,
    caches: cacheNames,
    cacheEntry: entry ? await entry.text() : null,
    registrations: (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => scope),
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
  };
  await fetch(`/__log?run=${encodeURIComponent(run)}`, {
    method: "POST",
    body: JSON.stringify(result),
  });
  (window as FixtureWindow).__inspected = result;
}

/** A value inlined into a script element; `<` is escaped so it cannot close the element. */
const literal = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

const page = (title: string, script: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><h1>${title}</h1><script type="module">${script}</script></body></html>`;

/** A page with no script, so only what a test writes ends up in its origin's storage. */
export const blankPage = page("Blank", "");

export const sentinelPage = (tag: string) =>
  page("Sentinel", `(${writeSentinels.toString()})(${literal(tag)});`);

export const inspectPage = (serverCookies: Record<string, string>, run: string) =>
  page("Inspect", `(${inspectStorage.toString()})(${literal(serverCookies)}, ${literal(run)});`);

export const serviceWorker = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
`;

// The installable fixture app at /pwa/; page and worker scripts are serialized with toString(), so
// they must not close over imports. Identity data: an HttpOnly cookie, localStorage, IndexedDB, and
// the worker's IndexedDB and Cache Storage.
import { literal } from "./app-pages.ts";

/** What the page's first inline script reads, before anything else of it runs. */
export interface PwaFirst {
  profile: string | null;
  idbUser: unknown;
  /** Whether a Service Worker controlled the document when the page started. */
  controlled: boolean;
  /** Whether a Service Worker answered the navigation (`workerStart` > 0). */
  servedByWorker: boolean;
  version: number;
  time: number;
}

/** The registration once a worker controls the page. */
export interface PwaReady {
  controller: string;
  scope: string;
  registerError: string | null;
  time: number;
}

/** What the worker answers to `whoami`, after its own authenticated fetch. */
export interface PwaAnswer {
  version: number;
  me: { user: string | null; version: number; from: string } | { offline: true; cached: unknown };
  /** The page's IndexedDB profile, as the worker reads it. */
  idbUser: unknown;
  /** The user the worker recorded on the previous `whoami`, before this one. */
  lastSeen: unknown;
  caches: string[];
}

interface PwaWindow {
  __pwa: {
    first?: PwaFirst;
    ready?: PwaReady;
    failure?: string;
    signIn: (user: string) => Promise<void>;
    ask: () => Promise<PwaAnswer>;
    update: () => Promise<string>;
  };
}

/** Reads one IndexedDB record, creating the database with its single store when it is absent. */
function idbGet(name: string, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(store);
    open.onerror = () => reject(open.error ?? new Error("open failed"));
    open.onsuccess = () => {
      const read = open.result.transaction(store).objectStore(store).get(key);
      read.onsuccess = () => {
        open.result.close();
        resolve(read.result ?? null);
      };
      read.onerror = () => reject(read.error ?? new Error("read failed"));
    };
  });
}

/** Writes one IndexedDB record, creating the database with its single store when it is absent. */
function idbPut(name: string, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(store);
    open.onerror = () => reject(open.error ?? new Error("open failed"));
    open.onsuccess = () => {
      const transaction = open.result.transaction(store, "readwrite");
      transaction.objectStore(store).put(value, key);
      transaction.oncomplete = () => {
        open.result.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("write failed"));
    };
  });
}

/** The page: first reads and their beacon, then registration, sign-in, `whoami`, and update. */
function pwaPage(run: string, version: number, get: typeof idbGet, put: typeof idbPut): void {
  const query = `run=${encodeURIComponent(run)}`;
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const pwa: PwaWindow["__pwa"] = {
    signIn: async (user) => {
      await fetch(`/pwa/login?${query}&user=${encodeURIComponent(user)}`);
      localStorage.setItem("pwa_profile", user);
      await put("pwa", "kv", "user", user);
    },
    ask: () => {
      const channel = new MessageChannel();
      const answer = new Promise<PwaAnswer>((resolve) => {
        channel.port1.onmessage = (event: MessageEvent<PwaAnswer>) => resolve(event.data);
      });
      navigator.serviceWorker.controller?.postMessage("whoami", [channel.port2]);
      return answer;
    },
    update: async () => {
      const registration = await navigator.serviceWorker.getRegistration("/pwa/");
      const changed = new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve());
      });
      await registration?.update();
      await changed;
      // The controller changes before the activate event ends, so wait for its cleanup too.
      const worker = navigator.serviceWorker.controller;
      if (worker && worker.state !== "activated")
        await new Promise((resolve) => {
          worker.addEventListener("statechange", resolve, { once: true });
        });
      return worker?.scriptURL ?? "";
    },
  };
  (window as unknown as PwaWindow).__pwa = pwa;
  const controlled = navigator.serviceWorker.controller !== null;
  const servedByWorker = (navigation?.workerStart ?? 0) > 0;
  const profile = localStorage.getItem("pwa_profile");
  const registered = async (): Promise<string | null> => {
    try {
      await navigator.serviceWorker.register(`/pwa/sw.js?${query}`, { scope: "/pwa/" });
      return null;
    } catch (error) {
      return String(error);
    }
  };
  const start = async () => {
    const idbUser = await get("pwa", "kv", "user");
    const first = { profile, idbUser, controlled, servedByWorker, version, time: Date.now() };
    pwa.first = first;
    navigator.sendBeacon(`/__log?${query}`, JSON.stringify({ phase: "pwa-first", ...first }));
    const registerError = await registered();
    const registration = await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller === null)
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      });
    const controller = navigator.serviceWorker.controller?.scriptURL ?? "";
    pwa.ready = { controller, scope: registration.scope, registerError, time: Date.now() };
  };
  start().catch((error: unknown) => {
    pwa.failure = String(error);
  });
}

/** `/pwa/?run=`: the manifest, the first inline script, and the version the server serves. */
export function pwaHtml(run: string, version: number): string {
  const args = `${literal(run)}, ${version}, ${idbGet.toString()}, ${idbPut.toString()}`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PWA v${version}</title>` +
    `<link rel="manifest" href="/pwa/manifest.json">` +
    `<script>(${pwaPage.toString()})(${args});</script>` +
    `</head><body><h1>PWA v${version}</h1></body></html>`
  );
}

export const pwaManifest = JSON.stringify({
  name: "RECnRun POC PWA",
  short_name: "PWA",
  start_url: "/pwa/",
  scope: "/pwa/",
  display: "standalone",
  icons: [{ src: "/app/pixel.svg", sizes: "any", type: "image/svg+xml" }],
});

interface Extendable {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: Extendable) => void): void;
  addEventListener(
    type: "fetch",
    listener: (
      event: Extendable & { request: Request; respondWith(r: Promise<Response>): void },
    ) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: Extendable & { ports: readonly MessagePort[] }) => void,
  ): void;
}

/** The worker: precaches the page, claims clients, serves navigations network-first, answers `whoami`. */
function pwaWorker(version: number, get: typeof idbGet, put: typeof idbPut): void {
  const scope = self as unknown as WorkerScope;
  const query = `run=${encodeURIComponent(new URL(scope.location.href).searchParams.get("run") ?? "")}`;
  const shell = `pwa-v${version}`;
  const ME = "/pwa/api/me";
  scope.addEventListener("install", (event) => {
    event.waitUntil(
      caches
        .open(shell)
        .then((cache) => cache.add(`/pwa/?${query}`))
        .then(() => scope.skipWaiting()),
    );
  });
  const activate = async () => {
    const stale = (await caches.keys()).filter((key) => key.startsWith("pwa-v") && key !== shell);
    await Promise.all(stale.map((key) => caches.delete(key)));
    await scope.clients.claim();
  };
  scope.addEventListener("activate", (event) => event.waitUntil(activate()));
  const navigate = async (request: Request) => {
    try {
      const response = await fetch(request);
      if (response.ok) await (await caches.open(shell)).put(request, response.clone());
      return response;
    } catch {
      return (await caches.match(request, { cacheName: shell })) ?? Response.error();
    }
  };
  scope.addEventListener("fetch", (event) => {
    if (event.request.mode === "navigate") event.respondWith(navigate(event.request));
  });
  const me = async (): Promise<PwaAnswer["me"]> => {
    try {
      const response = await fetch(`${ME}?${query}`, { headers: { "x-pwa-from": "worker" } });
      await (await caches.open("pwa-api")).put(ME, response.clone());
      return (await response.json()) as PwaAnswer["me"];
    } catch {
      const cached = await caches.match(ME, { cacheName: "pwa-api" });
      return { offline: true, cached: cached ? await cached.json() : null };
    }
  };
  const whoami = async (): Promise<PwaAnswer> => {
    const idbUser = await get("pwa", "kv", "user");
    const lastSeen = await get("pwa-sw", "seen", "last");
    const answer = await me();
    await put("pwa-sw", "seen", "last", "user" in answer ? answer.user : null);
    return { version, me: answer, idbUser, lastSeen, caches: (await caches.keys()).toSorted() };
  };
  scope.addEventListener("message", (event) => {
    event.waitUntil(whoami().then((answer) => event.ports[0]?.postMessage(answer)));
  });
}

/** `/pwa/sw.js?run=`: its bytes change with the server's version, so an update installs it. */
export const pwaServiceWorker = (version: number) =>
  `(${pwaWorker.toString()})(${version}, ${idbGet.toString()}, ${idbPut.toString()});`;

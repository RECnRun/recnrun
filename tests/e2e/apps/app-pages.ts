// The conventional fixture app at /app/; page scripts are serialized with toString(), so they must
// not close over imports. Observation only: nothing here waits for the extension.

/** What the app's first inline script reads, before anything else of the page runs. */
export interface FirstReads {
  cookie: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  idbRecord: unknown;
  /** Whether a Service Worker already controlled the document when the app started. */
  controlled: boolean;
  time: number;
}

/** What the app observed, on `window.__app`. */
export interface AppState {
  run: string;
  first?: FirstReads;
  module?: boolean;
  worker?: string;
  frame?: boolean;
  image?: boolean;
  fetched?: string;
  unnonced: boolean;
  violations: { directive: string; blocked: string }[];
  done?: boolean;
  failure?: string;
}

interface AppWindow {
  __app: AppState;
  __appFrame: Promise<void>;
}

/**
 * The first inline script of `<head>`: reads Web Storage and `document.cookie` synchronously,
 * starts an IndexedDB open and read, and beacons what it read before anything else of the app runs.
 */
function observeFirst(run: string): void {
  const scope = window as unknown as AppWindow;
  const app: AppState = { run, unnonced: false, violations: [] };
  scope.__app = app;
  document.addEventListener("securitypolicyviolation", (event) => {
    app.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
  });
  scope.__appFrame = new Promise((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.origin === location.origin && event.data === "frame-ready") resolve();
    });
  });
  const entries = (storage: Storage) =>
    Object.fromEntries(Object.keys(storage).map((key) => [key, storage.getItem(key) ?? ""]));
  const first: FirstReads = {
    cookie: document.cookie,
    localStorage: entries(localStorage),
    sessionStorage: entries(sessionStorage),
    idbRecord: null,
    controlled: navigator.serviceWorker.controller !== null,
    time: Date.now(),
  };
  const beacon = () => {
    app.first = first;
    navigator.sendBeacon(
      `/__log?run=${encodeURIComponent(run)}`,
      JSON.stringify({ phase: "first", ...first }),
    );
  };
  // A conventional app: version 1 creates its store, then the first read.
  const open = indexedDB.open("app", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  open.onerror = () => {
    app.failure = `IndexedDB open failed: ${String(open.error)}`;
  };
  open.onsuccess = () => {
    const db = open.result;
    const read = db.transaction("kv").objectStore("kv").get("marker");
    read.onsuccess = () => {
      first.idbRecord = read.result ?? null;
      db.close();
      beacon();
    };
  };
}

/** The app's module script: starts a dedicated worker, waits for the subframe and the image, fetches. */
async function runModule(): Promise<void> {
  const scope = window as unknown as AppWindow;
  const app = scope.__app;
  app.module = true;
  try {
    const run = encodeURIComponent(app.run);
    const worker = new Worker(`/app/worker.js?run=${run}`);
    const fromWorker = new Promise<string>((resolve) => {
      worker.onmessage = (event: MessageEvent<string>) => resolve(event.data);
    });
    worker.postMessage("hello");
    const image = document.querySelector("img");
    app.image = image ? await image.decode().then(() => true) : false;
    app.fetched = (
      (await (await fetch(`/app/data.json?run=${run}`)).json()) as { status: string }
    ).status;
    app.worker = await fromWorker;
    await scope.__appFrame;
    app.frame = true;
    app.done = true;
  } catch (error) {
    app.failure = String(error);
  }
}

function frameReady(): void {
  parent.postMessage("frame-ready", location.origin);
}

/** A value inlined into a script element; `<` is escaped so it cannot close the element. */
export const literal = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/** The site's own strict policy for `?csp=1`: same-origin resources and the nonced inline script. */
export const siteCsp = (nonce: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "img-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");

/** `/app/`: the first inline script, a module, a forbidden inline script, a subframe, an image. */
export function appPage(run: string, nonce: string): string {
  const query = `run=${encodeURIComponent(run)}`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title>` +
    `<script nonce="${nonce}">(${observeFirst.toString()})(${literal(run)});</script>` +
    `<script type="module" src="/app/module.js?${query}"></script></head>` +
    `<body><h1>App</h1>` +
    // No nonce: the site's CSP must keep forbidding it.
    `<script>window.__app.unnonced = true;</script>` +
    `<iframe title="App frame" src="/app/frame?${query}"></iframe>` +
    `<img alt="" src="/app/pixel.svg?${query}">` +
    `</body></html>`
  );
}

export const appModule = `(${runModule.toString()})();`;

export const appWorker = `self.onmessage = () => self.postMessage("ready");`;

export const appFrame =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Frame</title></head>` +
  `<body><script>(${frameReady.toString()})();</script></body></html>`;

export const appPixel =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">` +
  `<rect width="1" height="1"/></svg>`;

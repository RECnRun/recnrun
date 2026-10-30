import type { Page, Worker } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { identity, newIdentity, opened, switchTo } from "./fixtures/panel.ts";
import { openSite } from "./fixtures/session.ts";
import { openTabIn } from "./fixtures/tabs.ts";
import { managedWindow, pageAt } from "./fixtures/workspace.ts";
import { SPA_PATH } from "./apps/spa-routes.ts";

test.use({ incognitoAccess: true });

const STORES = { local: "local", session: "session", database: "database", cache: "cached" };

/** Writes one value in each of the SPA's four stores, as the app keeps its state. */
const writeStores = (page: Page) =>
  page.evaluate(async () => {
    localStorage.setItem("spa", "local");
    sessionStorage.setItem("spa", "session");
    const open = indexedDB.open("spa-db", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("state");
    const db = await new Promise<IDBDatabase>(
      (resolve) => (open.onsuccess = () => resolve(open.result)),
    );
    const write = db.transaction("state", "readwrite");
    write.objectStore("state").put("database", "spa");
    await new Promise((resolve) => (write.oncomplete = resolve));
    db.close();
    await (await caches.open("spa-cache")).put("/spa/cached", new Response("cached"));
  });

/** What the SPA's four stores hold; null where a store has nothing. */
const readStores = (page: Page) =>
  page.evaluate(async () => {
    const databases = await indexedDB.databases();
    let database: unknown = null;
    if (databases.some(({ name }) => name === "spa-db")) {
      const open = indexedDB.open("spa-db");
      const db = await new Promise<IDBDatabase>(
        (resolve) => (open.onsuccess = () => resolve(open.result)),
      );
      const read = db.transaction("state").objectStore("state").get("spa");
      database = await new Promise(
        (resolve) => (read.onsuccess = () => resolve(read.result ?? null)),
      );
      db.close();
    }
    const cached = (await caches.has("spa-cache"))
      ? await (await caches.open("spa-cache")).match("/spa/cached")
      : undefined;
    return {
      local: localStorage.getItem("spa"),
      session: sessionStorage.getItem("spa"),
      database,
      cache: cached ? await cached.text() : null,
    };
  });

/** Records, in the service worker, when each tab finished loading from now on. */
const watchLoads = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as {
      chrome: {
        tabs: {
          onUpdated: {
            addListener(f: (id: number, c: { status?: string }, t: { url?: string }) => void): void;
          };
        };
      };
      __loads?: { url: string; at: number }[];
      __mark?: number;
    };
    scope.__loads = [];
    scope.__mark = Date.now();
    scope.chrome.tabs.onUpdated.addListener((_id, { status }, { url = "" }) => {
      if (status === "complete") scope.__loads?.push({ url, at: Date.now() - (scope.__mark ?? 0) });
    });
  });

const loads = (serviceWorker: Worker) =>
  serviceWorker.evaluate(
    () => (globalThis as unknown as { __loads?: { url: string; at: number }[] }).__loads ?? [],
  );

for (const host of ["spa-binary", "spa-html", "spa-meta"]) {
  test(`a second tab on ${host}, an SPA behind SSO, comes back with its four stores`, async ({
    context,
    serviceWorker,
  }) => {
    const origin = `http://${host}.localhost:5192`;
    const site = await openSite(context, "/");
    await newIdentity(site, BLANK);
    await opened(site, "A");
    const managed = await managedWindow(serviceWorker);
    if (managed?.status !== "active") throw new Error("No managed window is open.");
    await openTabIn(serviceWorker, managed.windowId, `${origin}/spa/signin`);
    const spa = await pageAt(context, `${origin}${SPA_PATH}`);
    await writeStores(spa);
    expect(await readStores(spa)).toEqual(STORES);

    await newIdentity(site, BLANK);
    await opened(site, "B");
    await watchLoads(serviceWorker);
    await switchTo(site, "A");
    await opened(site, "A");
    const back = await pageAt(context, `${origin}${SPA_PATH}`);
    const row = await identity(site, "A").innerText();
    const timeline = await loads(serviceWorker);
    test.info().annotations.push({ type: "loads", description: JSON.stringify(timeline) });
    expect(await readStores(back), row).toEqual(STORES);
  });
}

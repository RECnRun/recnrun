import type { Page } from "@playwright/test";

/** One identity's marker as its page reads it from each kind of storage, null where absent. */
export interface Marker {
  cookie: string | null;
  localStorage: string | null;
  sessionStorage: string | null;
  indexedDB: string | null;
}

/** What a page that holds `value` everywhere reads; `null` for a page that never held one. */
export const marked = (value: string | null): Marker => ({
  cookie: value,
  localStorage: value,
  sessionStorage: value,
  indexedDB: value,
});

/** Writes `value` as a cookie, in both Web Storages, and in IndexedDB `markers`, then resolves. */
export const writeMarker = (page: Page, value: string) =>
  page.evaluate(async (marker) => {
    document.cookie = `marker=${marker}; path=/`;
    localStorage.setItem("marker", marker);
    sessionStorage.setItem("marker", marker);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("markers", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("kv");
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error("open failed"));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(marker, "marker");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("aborted"));
    });
    db.close();
  }, value);

/** Reads the marker back from each kind of storage, creating nothing. */
export const readMarker = (page: Page): Promise<Marker> =>
  page.evaluate(async () => {
    const cookie = /(?:^|; )marker=([^;]*)/.exec(document.cookie)?.[1] ?? null;
    const names = (await indexedDB.databases()).map(({ name }) => name);
    const indexedDBValue = names.includes("markers")
      ? await new Promise<string | null>((resolve, reject) => {
          const opening = indexedDB.open("markers");
          opening.onerror = () => reject(opening.error ?? new Error("open failed"));
          opening.onsuccess = () => {
            const read = opening.result.transaction("kv").objectStore("kv").get("marker");
            read.onsuccess = () => {
              opening.result.close();
              resolve((read.result as string | undefined) ?? null);
            };
          };
        })
      : null;
    return {
      cookie,
      localStorage: localStorage.getItem("marker"),
      sessionStorage: sessionStorage.getItem("marker"),
      indexedDB: indexedDBValue,
    };
  });

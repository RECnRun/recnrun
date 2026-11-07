// W6.14 readout: what the master keeps, searched by content after streaming.
import {
  cacheHits,
  databaseHits,
  holdsJpeg,
  holdsText,
  plantStores,
  unplantStores,
} from "./deep-scan.js";

const PLANT = "recnrun-plant";

const stores = async ({ name }) => {
  const request = indexedDB.open(name);
  const database = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const names = [...database.objectStoreNames];
  database.close();
  return { name, stores: names };
};

/** OPFS files whose bytes hold a JPEG. */
const opfsHits = async (root) => {
  const hits = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "file" && (await holdsJpeg(await handle.getFile()))) hits.push(name);
  }
  return hits;
};

/** localStorage, IndexedDB, Cache Storage, and the origin-private file system, by content. */
export const scan = async () => {
  const local = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key) ?? ""]);
  const root = await navigator.storage.getDirectory();
  const files = [];
  for await (const name of root.keys()) files.push(name);
  const jpegIn = [];
  for (const [key, value] of local) if (await holdsJpeg(value)) jpegIn.push(key);
  return {
    localStorageKeys: local.map(([key]) => key),
    jpegIn,
    databases: await Promise.all((await indexedDB.databases()).map(stores)),
    databaseHits: await databaseHits(),
    caches: await caches.keys(),
    cacheHits: await cacheHits(),
    opfs: files,
    opfsHits: await opfsHits(root),
  };
};

/** W7.C: every place the master keeps that holds `marker`: localStorage, stores, and caches. */
export const scanText = async (marker) => {
  const matches = holdsText(marker);
  const keys = Object.keys(localStorage).filter((key) =>
    localStorage.getItem(key)?.includes(marker),
  );
  return { keys, databaseHits: await databaseHits(matches), cacheHits: await cacheHits(matches) };
};

/** The positive control: a JPEG in localStorage, IndexedDB, Cache Storage, and OPFS. */
export const plant = async (base64) => {
  localStorage.setItem(PLANT, base64);
  await plantStores(base64);
  const file = await (
    await navigator.storage.getDirectory()
  ).getFileHandle(`${PLANT}.jpg`, {
    create: true,
  });
  const writable = await file.createWritable();
  await writable.write(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  await writable.close();
};

export const unplant = async () => {
  localStorage.removeItem(PLANT);
  await unplantStores();
  await (await navigator.storage.getDirectory()).removeEntry(`${PLANT}.jpg`);
};

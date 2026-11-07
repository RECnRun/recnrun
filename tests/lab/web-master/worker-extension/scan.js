// W6.14 readout: what the worker keeps, searched by content; the harness reads the result files.
import { cacheHits, databaseHits, holdsJpeg, plantStores, unplantStores } from "./deep-scan.js";

const PLANT_KEY = "recnrun-plant";

/** Storage keys (ledger included) whose values hold a JPEG, plus every store's and cache's hits. */
export const scan = async () => {
  const stored = { ...(await chrome.storage.local.get(null)) };
  const session = await chrome.storage.session.get(null);
  const downloads = await chrome.downloads.search({});
  const jpegIn = [];
  for (const [key, value] of Object.entries({ ...stored, ...session })) {
    if (await holdsJpeg(value)) jpegIn.push(key);
  }
  return {
    storageKeys: Object.keys(stored).sort(),
    sessionKeys: Object.keys(session),
    jpegIn,
    databases: (await indexedDB.databases()).map((database) => database.name),
    databaseHits: await databaseHits(),
    caches: await globalThis.caches.keys(),
    cacheHits: await cacheHits(),
    downloads: downloads.map((item) => item.filename),
  };
};

/** The positive control: a JPEG in chrome.storage, IndexedDB, and Cache Storage. */
export const plant = async (base64) => {
  await chrome.storage.local.set({ [PLANT_KEY]: base64 });
  await plantStores(base64);
};

export const unplant = async () => {
  await chrome.storage.local.remove(PLANT_KEY);
  await unplantStores();
};

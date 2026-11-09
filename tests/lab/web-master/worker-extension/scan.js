// W6.14 readout: what the worker keeps, searched by content; the harness reads the result files.
import {
  cacheHits,
  databaseHits,
  holdsJpeg,
  holdsText,
  opfsFileHits,
  plantStores,
  unplantStores,
} from "./deep-scan.js";

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

// The service worker has no Web Storage: the offscreen document's localStorage and
// sessionStorage are read there; null when it does not answer.
const pageKeys = (marker) =>
  chrome.runtime.sendMessage({ target: "offscreen", type: "scan-text", marker }).then(
    (keys) => (Array.isArray(keys) ? keys : null),
    () => null,
  );

/** W7.C: every place the worker keeps that holds `marker`: storage, stores, caches, and OPFS. */
export const scanText = async (marker) => {
  const matches = holdsText(marker);
  const stored = {
    ...(await chrome.storage.local.get(null)),
    ...(await chrome.storage.session.get(null)),
  };
  const keys = [];
  for (const [key, value] of Object.entries(stored)) if (await matches(value)) keys.push(key);
  return {
    keys,
    pageKeys: await pageKeys(marker),
    databaseHits: await databaseHits(matches),
    cacheHits: await cacheHits(matches),
    opfsHits: await opfsFileHits(matches),
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

// W6.14: a frame is found by its JPEG start bytes, raw or base64, in every value an origin keeps.
// site/deep-scan.js is the same file: the master page and the worker load from separate roots.
const PLANT = "recnrun-plant";

const startsJpeg = (bytes) => {
  for (let index = 0; index + 2 < bytes.length; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff)
      return true;
  }
  return false;
};

/** True when `value`, or anything inside it, holds a JPEG: bytes, Blob, base64, or binary text. */
export const holdsJpeg = async (value) => {
  if (value instanceof Blob) return startsJpeg(new Uint8Array(await value.arrayBuffer()));
  if (value instanceof ArrayBuffer) return startsJpeg(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return startsJpeg(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof value === "string") return value.includes("/9j/") || value.includes("ÿØÿ");
  if (!value || typeof value !== "object") return false;
  for (const item of Object.values(value)) if (await holdsJpeg(item)) return true;
  return false;
};

const settled = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Every IndexedDB store whose values hold a JPEG, as "database/store". */
export const databaseHits = async () => {
  const hits = [];
  for (const { name } of await indexedDB.databases()) {
    const database = await settled(indexedDB.open(name));
    for (const store of database.objectStoreNames) {
      const values = await settled(database.transaction(store).objectStore(store).getAll());
      if (await holdsJpeg(values)) hits.push(`${name}/${store}`);
    }
    database.close();
  }
  return hits;
};

/** Every Cache Storage entry whose body holds a JPEG, as "cache url". */
export const cacheHits = async () => {
  const hits = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response && (await holdsJpeg(await response.arrayBuffer()))) {
        hits.push(`${name} ${request.url}`);
      }
    }
  }
  return hits;
};

/** The positive control: one JPEG in IndexedDB and in Cache Storage, for the scan to find. */
export const plantStores = async (base64) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const opening = indexedDB.open(PLANT, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("frames");
  const database = await settled(opening);
  await settled(database.transaction("frames", "readwrite").objectStore("frames").put(bytes, 1));
  database.close();
  // An absolute https key: Cache Storage refuses chrome-extension: request URLs.
  await (await caches.open(PLANT)).put("https://plant.invalid/plant.jpg", new Response(bytes));
};

export const unplantStores = async () => {
  await settled(indexedDB.deleteDatabase(PLANT));
  await caches.delete(PLANT);
};

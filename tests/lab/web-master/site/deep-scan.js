// W6.14: a frame is found by its JPEG start bytes, raw or base64, in every value an origin keeps.
// worker-extension/deep-scan.js is the same file: the master page and the worker load from separate roots.
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

const decoded = (bytes) => new TextDecoder().decode(bytes);

/** A matcher like holdsJpeg for one string, raw or as UTF-8 bytes (W7.C's typed marker). */
export const holdsText = (marker) => {
  const holds = async (value) => {
    if (value instanceof Blob) return (await value.text()).includes(marker);
    if (value instanceof ArrayBuffer) return decoded(new Uint8Array(value)).includes(marker);
    if (ArrayBuffer.isView(value)) return decoded(value).includes(marker);
    if (typeof value === "string") return value.includes(marker);
    if (!value || typeof value !== "object") return false;
    for (const item of Object.values(value)) if (await holds(item)) return true;
    return false;
  };
  return holds;
};

const settled = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Every IndexedDB store whose values `matches` (a JPEG by default), as "database/store". */
export const databaseHits = async (matches = holdsJpeg) => {
  const hits = [];
  for (const { name } of await indexedDB.databases()) {
    const database = await settled(indexedDB.open(name));
    for (const store of database.objectStoreNames) {
      const values = await settled(database.transaction(store).objectStore(store).getAll());
      if (await matches(values)) hits.push(`${name}/${store}`);
    }
    database.close();
  }
  return hits;
};

/** Every Cache Storage entry whose body `matches` (a JPEG by default), as "cache url". */
export const cacheHits = async (matches = holdsJpeg) => {
  const hits = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response && (await matches(await response.arrayBuffer()))) {
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

/** OPFS files at any depth whose contents `matches`, as paths from the root. */
export const opfsFileHits = async (matches) =>
  folderHits(matches, await navigator.storage.getDirectory(), "");

const folderHits = async (matches, folder, prefix) => {
  const hits = [];
  for await (const [name, handle] of folder.entries()) {
    const path = `${prefix}${name}`;
    if (handle.kind === "directory") hits.push(...(await folderHits(matches, handle, `${path}/`)));
    else if (await matches(await handle.getFile())) hits.push(path);
  }
  return hits;
};

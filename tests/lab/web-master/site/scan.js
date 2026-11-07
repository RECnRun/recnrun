// W6.14 readout: what the master keeps, searched for a JPEG (base64 or raw) after streaming.
const holdsJpeg = (text) => text.includes("/9j/") || text.includes("ÿØ");

const opened = (name) =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const stores = async ({ name }) => {
  const database = await opened(name);
  const names = [...database.objectStoreNames];
  database.close();
  return { name, stores: names };
};

/** localStorage, IndexedDB, Cache Storage, and the origin-private file system of this origin. */
export const scan = async () => {
  const local = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key) ?? ""]);
  const root = await navigator.storage.getDirectory();
  const files = [];
  for await (const name of root.keys()) files.push(name);
  return {
    localStorageKeys: local.map(([key]) => key),
    jpegIn: local.filter(([, value]) => holdsJpeg(value)).map(([key]) => key),
    databases: await Promise.all((await indexedDB.databases()).map(stores)),
    caches: await caches.keys(),
    opfs: files,
  };
};

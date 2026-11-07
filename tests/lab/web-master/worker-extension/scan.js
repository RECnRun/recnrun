// W6.14 readout: what the worker keeps, searched for a JPEG; the harness reads the downloads.
const holdsJpeg = (value) => {
  const text = JSON.stringify(value);
  return text.includes("/9j/") || text.includes("\\u00ff\\u00d8");
};

/** Storage keys, IndexedDB databases, Cache Storage, download paths, and keys holding a JPEG. */
export const scan = async () => {
  const stored = { ...(await chrome.storage.local.get(null)) };
  const session = await chrome.storage.session.get(null);
  const downloads = await chrome.downloads.search({});
  return {
    storageKeys: Object.keys(stored).sort(),
    sessionKeys: Object.keys(session),
    jpegIn: Object.entries({ ...stored, ...session })
      .filter(([, value]) => holdsJpeg(value))
      .map(([key]) => key),
    databases: (await indexedDB.databases()).map((database) => database.name),
    caches: await globalThis.caches.keys(),
    downloads: downloads.map((item) => item.filename),
  };
};

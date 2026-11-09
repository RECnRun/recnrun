// What the owner page remembers in this browser: the chosen folder handle and the worker key pin.
const open = () =>
  new Promise((resolve, reject) => {
    const opening = indexedDB.open("recnrun-owner", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("kv");
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });

const run = async (mode, operation) => {
  const store = (await open()).transaction("kv", mode).objectStore("kv");
  return new Promise((resolve, reject) => {
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const remember = (key, value) => run("readwrite", (store) => store.put(value, key));
export const recall = (key) => run("readonly", (store) => store.get(key));

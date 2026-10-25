// Dedicated (classic or module) and shared worker: writes or reads its marker in IndexedDB and asks
// /me who it is. A shared worker also reports its instance and how many pages connected.
const instance = Math.random().toString(36).slice(2);
let connections = 0;

const request = (operation) =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });

async function marker(value) {
  const opening = indexedDB.open("worker-markers", 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("kv");
  const db = await request(opening);
  const store = db.transaction("kv", "readwrite").objectStore("kv");
  if (value !== undefined) await request(store.put(value, "marker"));
  const stored = await request(db.transaction("kv").objectStore("kv").get("marker"));
  db.close();
  return stored ?? null;
}

async function answer({ write }) {
  const me = await (await fetch("/me")).json();
  return {
    me: me.user,
    marker: await marker(write),
    instance,
    connections,
    location: self.location.pathname,
  };
}

if ("onconnect" in self) {
  self.onconnect = ({ ports: [port] }) => {
    connections += 1;
    port.onmessage = async ({ data }) => port.postMessage(await answer(data));
  };
} else {
  self.onmessage = async ({ data }) => self.postMessage(await answer(data));
}

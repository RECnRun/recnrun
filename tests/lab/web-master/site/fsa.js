// Throwaway rendezvous folder of the master: picked once, its handle kept in IndexedDB (W.fsa).
const MARKER = "recnrun-rendezvous.json";
const READWRITE = { mode: "readwrite" };

const request = (operation) =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });

const store = async (mode) => {
  const open = indexedDB.open("recnrun-lab-fsa", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("handles");
  return (await request(open)).transaction("handles", mode).objectStore("handles");
};

const storedHandle = async () => request((await store("readonly")).get("rendezvous"));

const show = (text) => {
  document.getElementById("folder").textContent = text;
};

// Both run inside a click handler: the picker and requestPermission need the user's activation.
const pick = async () => {
  const handle = await window.showDirectoryPicker({ id: "rendezvous", ...READWRITE });
  await request((await store("readwrite")).put(handle, "rendezvous"));
  show(`folder ${handle.name}`);
  return handle.name;
};

const restore = async () => {
  const handle = await storedHandle();
  const state = await handle.requestPermission(READWRITE);
  show(`folder ${handle.name} ${state}`);
  return state;
};

const status = async () => {
  const handle = await storedHandle();
  if (!handle) return { handle: false, permission: "none" };
  return { handle: true, name: handle.name, permission: await handle.queryPermission(READWRITE) };
};

const readMarker = async () => {
  const file = await (await (await storedHandle()).getFileHandle(MARKER)).getFile();
  return file.text();
};

const writeFile = async (name, text) => {
  const handle = await (await storedHandle()).getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
};

const persist = async () => ({
  persist: await navigator.storage.persist(),
  persisted: await navigator.storage.persisted(),
});

export const createFsa = () => {
  const results = [];
  const bind = (id, action) =>
    document.getElementById(id).addEventListener("click", () => {
      results.push(action().catch((error) => `error: ${String(error)}`));
    });
  bind("choose", pick);
  bind("restore", restore);
  const lastClick = () => results.at(-1);
  return { fsa: { status, readMarker, writeFile, persist, lastClick } };
};

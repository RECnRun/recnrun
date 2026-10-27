// Captures persisted in the extension's own IndexedDB, which keeps structured values as they are.
const DB = "origin-lab";
const STORE = "captures";

const settle = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function open() {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  return settle(request);
}

async function inStore(mode, action) {
  const db = await open();
  const transaction = db.transaction(STORE, mode, { durability: "strict" });
  const result = settle(action(transaction.objectStore(STORE)));
  await new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
  });
  db.close();
  return result;
}

const keyOf = (origin, identity) => `${origin}|${identity}`;

/** Resolves only once the transaction completed with strict durability. */
export const putCapture = (record) =>
  inStore("readwrite", (store) => store.put(record, keyOf(record.origin, record.identity)));

export const getCapture = (origin, identity) =>
  inStore("readonly", (store) => store.get(keyOf(origin, identity)));

export const allCaptures = () => inStore("readonly", (store) => store.getAll());

export const clearCaptures = () => inStore("readwrite", (store) => store.clear());

const byText = (a, b) => a.localeCompare(b);

/** Names and counts only: what a spec may read without moving the values out of the browser. */
export function summarize(state) {
  return {
    local: state.local.map(([key]) => key).sort(byText),
    session: state.session.map(([key]) => key).sort(byText),
    databases: state.databases.map((database) => ({
      name: database.name,
      version: database.version,
      stores: database.stores.map((store) => ({ name: store.name, count: store.values.length })),
    })),
    cookies: (state.cookies ?? []).map((cookie) => `${cookie.domain}${cookie.path} ${cookie.name}`),
  };
}

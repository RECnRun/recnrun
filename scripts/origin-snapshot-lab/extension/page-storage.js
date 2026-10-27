// Content-script library: capture, clear, and restore the origin's localStorage, sessionStorage,
// and IndexedDB from a document of that origin. It never touches the extension's storage.
const settle = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const completion = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
  });

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    const name = () => (typeof label === "function" ? label() : label);
    timer = setTimeout(() => reject(new Error(`${name()} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function openExisting(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`${name} vanished`));
  });
}

function describeStore(store) {
  const indexes = [...store.indexNames].map((name) => {
    const index = store.index(name);
    return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
  });
  return { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes };
}

async function captureDatabase(name) {
  const db = await openExisting(name);
  const names = [...db.objectStoreNames];
  const stores = [];
  if (names.length > 0) {
    const transaction = db.transaction(names, "readonly");
    // Every request is issued before the first await, so the transaction stays active.
    const reads = names.map((store) => {
      const objectStore = transaction.objectStore(store);
      const keys = settle(objectStore.getAllKeys());
      const values = settle(objectStore.getAll());
      return { name: store, ...describeStore(objectStore), keys, values };
    });
    for (const read of reads) {
      stores.push({ ...read, keys: await read.keys, values: await read.values });
    }
    await completion(transaction);
  }
  db.close();
  return { name, version: db.version, stores };
}

const entries = (storage) =>
  Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index);
    return [key, storage.getItem(key)];
  });

async function captureAll() {
  const started = performance.now();
  const names = (await indexedDB.databases()).map((info) => info.name).filter(Boolean);
  const databases = [];
  for (const name of names.sort((a, b) => a.localeCompare(b)))
    databases.push(await captureDatabase(name));
  const local = entries(localStorage);
  const session = entries(sessionStorage);
  return { local, session, databases, ms: performance.now() - started };
}

/** Deletes one database; `blocked` records whether another connection held it. */
function deleteDatabase(name, timeoutMs) {
  const outcome = { name, blocked: false };
  const request = indexedDB.deleteDatabase(name);
  request.onblocked = () => (outcome.blocked = true);
  const deleted = settle(request).then(() => outcome);
  return withTimeout(
    deleted,
    timeoutMs,
    () => `deleteDatabase(${name}) blocked=${outcome.blocked}`,
  );
}

/**
 * Asks for exclusive access without changing anything: an open at a higher version waits for
 * every other connection to close, and its upgrade is always aborted, so the version stays.
 */
function probeExclusive(name, version, timeoutMs) {
  const outcome = { name, blocked: false, exclusive: false };
  const request = indexedDB.open(name, version + 1);
  request.onblocked = () => (outcome.blocked = true);
  const probed = new Promise((resolve) => {
    request.onupgradeneeded = () => {
      outcome.exclusive = true;
      request.transaction.abort();
    };
    request.onerror = () => resolve(outcome);
    request.onsuccess = () => {
      request.result.close();
      resolve(outcome);
    };
  });
  return withTimeout(
    probed,
    timeoutMs,
    () => `exclusive access to ${name} blocked=${outcome.blocked}`,
  );
}

async function clearAll({ timeoutMs = 5000, probe = false } = {}) {
  const started = performance.now();
  const infos = (await indexedDB.databases()).filter((info) => info.name);
  if (probe) {
    for (const info of infos) await probeExclusive(info.name, info.version, timeoutMs);
  }
  const deleted = [];
  for (const info of infos) deleted.push(await deleteDatabase(info.name, timeoutMs));
  localStorage.clear();
  sessionStorage.clear();
  return { deleted, ms: performance.now() - started };
}

function createSchema(db, stores) {
  for (const store of stores) {
    const created = db.createObjectStore(store.name, {
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
    });
    for (const index of store.indexes) {
      created.createIndex(index.name, index.keyPath, {
        unique: index.unique,
        multiEntry: index.multiEntry,
      });
    }
  }
}

async function restoreDatabase({ name, version, stores }, timeoutMs) {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => createSchema(request.result, stores);
  const db = await withTimeout(settle(request), timeoutMs, `open(${name}, ${version})`);
  if (stores.length > 0) {
    const names = stores.map((store) => store.name);
    const transaction = db.transaction(names, "readwrite", { durability: "strict" });
    for (const store of stores) {
      const objectStore = transaction.objectStore(store.name);
      store.values.forEach((value, index) =>
        store.keyPath === null ? objectStore.put(value, store.keys[index]) : objectStore.put(value),
      );
    }
    await completion(transaction);
  }
  db.close();
}

async function restoreAll(state, { timeoutMs = 5000 } = {}) {
  const started = performance.now();
  for (const [key, value] of state.local) localStorage.setItem(key, value);
  for (const [key, value] of state.session) sessionStorage.setItem(key, value);
  for (const database of state.databases) await restoreDatabase(database, timeoutMs);
  return { ms: performance.now() - started };
}

self.__originLab = { captureAll, clearAll, restoreAll, probeExclusive, deleteDatabase };

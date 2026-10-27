// The fixture app. It never waits for the extension; the spec drives it through `window.app`
// as a user would, and URL flags turn on the contexts Experiment B needs.
const flags = new URLSearchParams(location.search);

function openAppDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("app-db", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("kv");
      const items = db.createObjectStore("items", { keyPath: "id", autoIncrement: true });
      items.createIndex("byTag", "tag");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function write(marker) {
  localStorage.setItem("marker", marker);
  sessionStorage.setItem("marker", marker);
  const db = await openAppDb();
  const transaction = db.transaction(["kv", "items"], "readwrite");
  transaction.objectStore("kv").put(marker, "marker");
  transaction.objectStore("items").add({ tag: marker });
  await done(transaction);
  db.close();
}

if (flags.has("beforeunload")) {
  addEventListener("beforeunload", (event) => event.preventDefault());
}

let held;
const contexts = {};
if (flags.has("conn")) held = await openAppDb();
if (flags.has("worker")) contexts.worker = new Worker("/worker.js?hold=1");
if (flags.has("shared")) contexts.shared = new SharedWorker("/shared-worker.js?hold=1");
if (flags.has("sw")) {
  await navigator.serviceWorker.register(`/sw.js?${flags.has("swhold") ? "hold=1" : ""}`);
  await navigator.serviceWorker.ready;
}

window.app = { write, openAppDb, held: () => Boolean(held), contexts };

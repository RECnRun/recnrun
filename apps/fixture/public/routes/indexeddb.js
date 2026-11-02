import { onClick, show, start } from "../fixture.js";

const STORE = "records";

function settle(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function openDatabase() {
  const request = indexedDB.open("recnrun-fixture", 1);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore(STORE, { autoIncrement: true });
  });
  return settle(request);
}

function outcome(transaction) {
  return new Promise((resolve) => {
    transaction.addEventListener("complete", () => resolve("committed"));
    transaction.addEventListener("abort", () => resolve("aborted"));
  });
}

const database = await openDatabase();

async function showCount() {
  const total = await settle(database.transaction(STORE).objectStore(STORE).count());
  show("record-count", `Records: ${total}`);
}

/** Adds one record, then commits the transaction or aborts it before it can commit. */
async function addRecord(abort) {
  const transaction = database.transaction(STORE, "readwrite");
  const finished = outcome(transaction);
  transaction.objectStore(STORE).add({ at: Date.now() });
  if (abort) transaction.abort();
  show("last-outcome", await finished);
  await showCount();
}

onClick("commit", "commits", () => void addRecord(false));
onClick("abort", "aborts", () => void addRecord(true));

await start("indexeddb", { counters: ["commits", "aborts"], selfTest: showCount });

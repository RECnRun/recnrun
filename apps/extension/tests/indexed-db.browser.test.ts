import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { request, transact } from "@/storage/indexed-db";
import { settled } from "./origin-storage";

const DATABASE = "recnrun-indexed-db-test";
let connection: IDBDatabase;

beforeEach(async () => {
  await settled(indexedDB.deleteDatabase(DATABASE));
  const opening = indexedDB.open(DATABASE, 1);
  opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore("kv"));
  connection = await request(opening);
});

afterEach(() => {
  connection.close();
});

const count = () =>
  transact(connection, ["kv"], "readonly", (tx) => request(tx.objectStore("kv").count()));

test("settles after the commit with the body's value", async () => {
  const written = transact(connection, ["kv"], "readwrite", (tx) =>
    request(tx.objectStore("kv").add("a", 1)),
  );
  await expect(written).resolves.toBe(1);
  await expect(count()).resolves.toBe(1);
});

test("a failed request rejects with its error, and the body's rejection aborts every write", async () => {
  const failing = transact(connection, ["kv"], "readwrite", async (tx) => {
    const store = tx.objectStore("kv");
    await request(store.add("a", 1));
    await request(store.add("b", 1));
  });
  await expect(failing).rejects.toMatchObject({ name: "ConstraintError" });
  await expect(count()).resolves.toBe(0);
});

test("a body that fails without a failed request aborts the transaction itself", async () => {
  const failing = transact(connection, ["kv"], "readwrite", async (tx) => {
    await request(tx.objectStore("kv").add("a", 1));
    throw new Error("Refused.");
  });
  await expect(failing).rejects.toThrow("Refused.");
  await expect(count()).resolves.toBe(0);
});

test("a body that awaits anything else lets the transaction commit early, which fails", async () => {
  // IndexedDB commits a transaction with no pending request at the end of a task.
  const early = transact(connection, ["kv"], "readwrite", async (tx) => {
    await request(tx.objectStore("kv").add("a", 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await expect(early).rejects.toThrow("The transaction committed before its work ended.");
});

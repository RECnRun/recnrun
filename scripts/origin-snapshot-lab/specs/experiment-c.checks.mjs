// Experiment C: does a capture survive the trip gate → background → extension IndexedDB → gate
// with every type IndexedDB can hold? T1 is structured clone messaging; the red control is the
// same extension with the default (JSON) serialization.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { startFixture } from "../fixture/server.mjs";
import { extensionCopy, launchLab, observed, openApp, writeEvidence } from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();

/** A copy of the lab extension without `message_serialization`, so messages use JSON. */
const jsonExtension = () =>
  extensionCopy(({ message_serialization: _json, ...manifest }) => manifest);

/** Runs in the page, as the app would: one database whose values and keys use every kind. */
async function writeTyped({ bigint, binaryKey }) {
  const blob = new Blob(["blob-bytes"], { type: "text/plain" });
  const values = {
    date: new Date(1700000000000),
    blob,
    file: new File(["file-bytes"], "a.txt", { type: "text/plain", lastModified: 1700000000000 }),
    buffer: new Uint8Array([1, 2, 3]).buffer,
    typed: new Float64Array([1.5, -0, Number.NaN]),
    view: new DataView(new Uint8Array([9, 8]).buffer),
    map: new Map([["k", new Date(0)]]),
    set: new Set([1, "two"]),
    regexp: /a+b/giu,
    error: new RangeError("boom"),
    special: [undefined, null, Number.NaN, -0, Infinity],
    sparse: Object.assign([], { 0: 1, 2: 3, length: 3 }),
    boxed: new String("boxed"),
  };
  // JSON messaging throws on a BigInt and turns a binary key into an invalid one; without them,
  // the controls show what it does to the other types.
  if (bigint) values.bigint = 12345678901234567890n;
  const keys = [["compound", 1], new Date(1), -0, ""];
  if (binaryKey) keys.push(new Uint8Array([1, 2]).buffer);
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("typed-db", 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("values");
      request.result.createObjectStore("keys");
      request.result.createObjectStore("generated", { autoIncrement: true });
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(["values", "keys", "generated"], "readwrite");
      for (const [name, value] of Object.entries(values))
        transaction.objectStore("values").put(value, name);
      keys.forEach((key, index) => transaction.objectStore("keys").put(index, key));
      const generated = transaction.objectStore("generated");
      for (let index = 0; index < 5; index += 1) generated.add({ index });
      // The key generator stays at 6 after the highest key is deleted.
      generated.delete(5);
      transaction.oncomplete = () => resolve(db.close());
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
  localStorage.setItem("", "empty key");
  localStorage.setItem("unicode", "ação \u{1F600} \u0000 end");
  sessionStorage.setItem("json", JSON.stringify({ nested: [1, 2] }));
}

/** Runs in the page: a typed description of typed-db and web storage, comparable as JSON. */
async function describeTyped() {
  const number = (item) => (Object.is(item, -0) ? "-0" : String(item));
  const entries = (pairs) => Promise.all(pairs.map(async ([k, v]) => [k, await tag(v)]));
  // The first matching kind describes the value; File comes before Blob, DataView before views.
  const kinds = [
    [(v) => v === undefined, () => ["undefined"]],
    [(v) => typeof v === "number", (v) => ["number", number(v)]],
    [(v) => typeof v === "bigint", (v) => ["bigint", String(v)]],
    [(v) => v === null || typeof v !== "object", (v) => [typeof v, v]],
    [(v) => v instanceof Date, (v) => ["Date", v.getTime()]],
    [
      (v) => v instanceof File,
      async (v) => ["File", v.name, v.type, v.lastModified, await v.text()],
    ],
    [(v) => v instanceof Blob, async (v) => ["Blob", v.type, await v.text()]],
    [(v) => v instanceof ArrayBuffer, (v) => ["ArrayBuffer", [...new Uint8Array(v)]]],
    [(v) => v instanceof DataView, (v) => ["DataView", [...new Uint8Array(v.buffer)]]],
    [(v) => ArrayBuffer.isView(v), (v) => [v.constructor.name, [...v].map(number)]],
    [(v) => v instanceof Map, async (v) => ["Map", await entries([...v])]],
    [(v) => v instanceof Set, (v) => ["Set", [...v]]],
    [(v) => v instanceof RegExp, (v) => ["RegExp", v.source, v.flags]],
    [(v) => v instanceof Error, (v) => ["Error", v.name, v.message]],
    [(v) => v instanceof String, (v) => ["String", v.valueOf()]],
    [
      Array.isArray,
      async (v) => ["Array", v.length, Object.keys(v), await Promise.all([...v].map(tag))],
    ],
    [() => true, async (v) => ["Object", await entries(Object.entries(v))]],
  ];
  async function tag(value) {
    return kinds.find(([matches]) => matches(value))[1](value);
  }
  const read = (db, store) =>
    new Promise((resolve) => {
      const objectStore = db.transaction(store).objectStore(store);
      const keys = objectStore.getAllKeys();
      const values = objectStore.getAll();
      values.onsuccess = () => resolve({ keys: keys.result, values: values.result });
    });
  const db = await new Promise((resolve) => {
    const request = indexedDB.open("typed-db");
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  if (!db) return { missing: true };
  const stores = {};
  for (const store of ["values", "keys", "generated"]) {
    const { keys, values } = await read(db, store);
    stores[store] = {
      keys: await Promise.all(keys.map(tag)),
      values: await Promise.all(values.map(tag)),
    };
  }
  const next = await new Promise((resolve) => {
    const transaction = db.transaction("generated", "readwrite");
    const request = transaction.objectStore("generated").add({ probe: true });
    request.onsuccess = () => {
      resolve(request.result);
      transaction.abort();
    };
  });
  db.close();
  const local = Object.fromEntries(
    Object.keys(localStorage)
      .sort()
      .map((key) => [key, localStorage.getItem(key)]),
  );
  const session = Object.fromEntries(
    Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
  );
  return { version: db.version, stores, nextGeneratedKey: next, local, session };
}

/** A writes the typed data, B starts, A resumes; returns A's description before and after. */
async function roundTrip(session, kinds) {
  const { page, tabId } = await openApp(session);
  await session.lab.switchTo(tabId, "A");
  await observed(page);
  await page.evaluate(writeTyped, kinds);
  const before = await page.evaluate(describeTyped);
  await session.lab.switchTo(tabId, "B");
  const inB = await page.evaluate(describeTyped);
  await session.lab.switchTo(tabId, "A");
  await observed(page);
  return { before, inB, after: await page.evaluate(describeTyped) };
}

/** The top-level entries whose descriptions differ, by path. */
function differences(before, after) {
  const paths = [];
  for (const [store, { values }] of Object.entries(before.stores)) {
    values.forEach((value, index) => {
      if (JSON.stringify(value) !== JSON.stringify(after.stores?.[store]?.values?.[index])) {
        paths.push(`${store}[${JSON.stringify(before.stores[store].keys[index])}]`);
      }
    });
    if (JSON.stringify(before.stores[store].keys) !== JSON.stringify(after.stores?.[store]?.keys)) {
      paths.push(`${store} keys`);
    }
  }
  for (const field of ["version", "nextGeneratedKey", "local", "session"]) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) paths.push(field);
  }
  return paths;
}

const ALL = { bigint: true, binaryKey: true };
for (const { name, serialization, kinds } of [
  { name: "T1 structured clone messaging", serialization: "structured_clone", kinds: ALL },
  { name: "control: JSON messaging", serialization: "json", kinds: ALL },
  {
    name: "control: JSON messaging, no BigInt",
    serialization: "json",
    kinds: { bigint: false, binaryKey: true },
  },
  {
    name: "control: JSON messaging, no BigInt or binary key",
    serialization: "json",
    kinds: { bigint: false, binaryKey: false },
  },
]) {
  await test(`types round trip, ${name}`, async () => {
    const extension = serialization === "json" ? jsonExtension() : undefined;
    const session = await launchLab({ extension });
    try {
      const outcome = await roundTrip(session, kinds).then(
        (trip) => ({ ok: true, ...trip, differences: differences(trip.before, trip.after) }),
        (error) => ({ ok: false, error: String(error?.message ?? error) }),
      );
      evidence[name] = outcome;
      const generated = [outcome.before?.nextGeneratedKey, outcome.after?.nextGeneratedKey];
      console.log(
        JSON.stringify({
          name,
          ok: outcome.ok,
          error: outcome.error,
          differences: outcome.differences,
          generated,
        }),
      );
      if (serialization === "json") {
        assert.ok(!outcome.ok || outcome.differences.length > 0, "JSON messaging must lose types");
      } else {
        assert.equal(outcome.ok, true, outcome.error);
        assert.equal(outcome.inB.missing, true, "B starts without A's database");
        assert.deepEqual(
          outcome.differences.filter((path) => path !== "nextGeneratedKey"),
          [],
        );
      }
    } finally {
      await session.close();
      if (extension) rmSync(extension, { recursive: true, force: true });
    }
  });
}

/** Runs in the page: `count` records of about `size` bytes in app-db's items store. */
async function writeMany([count, size]) {
  const db = await window.app.openAppDb();
  const transaction = db.transaction("items", "readwrite");
  const filler = "x".repeat(size);
  for (let index = 0; index < count; index += 1) {
    transaction.objectStore("items").put({ id: index + 1, tag: `t${index % 10}`, filler });
  }
  await new Promise((resolve) => (transaction.oncomplete = resolve));
  db.close();
  localStorage.setItem("marker", "big");
}

const RECORDS = Number(process.env.ORIGIN_LAB_RECORDS ?? 10000);

await test(`large capture: ${RECORDS} records of about 1 kB`, async () => {
  const session = await launchLab();
  try {
    const { page, tabId } = await openApp(session);
    await session.lab.switchTo(tabId, "A");
    await observed(page);
    await page.evaluate(writeMany, [RECORDS, 1000]);
    const suspend = await session.lab.switchTo(tabId, "B");
    const resume = await session.lab.switchTo(tabId, "A");
    const count = await page.evaluate(async () => {
      const db = await window.app.openAppDb();
      const request = db.transaction("items").objectStore("items").count();
      return new Promise((resolve) => (request.onsuccess = () => resolve(request.result)));
    });
    const timing = (receipt) => ({ ms: Math.round(receipt.ms), marks: receipt.report.marks });
    evidence.large = { records: RECORDS, count, suspend: timing(suspend), resume: timing(resume) };
    console.log(JSON.stringify(evidence.large));
    assert.equal(count, RECORDS);
  } finally {
    await session.close();
  }
});

await fixture.close();
writeEvidence("experiment-c", evidence);

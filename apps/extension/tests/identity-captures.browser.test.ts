import { beforeEach, expect, test } from "vite-plus/test";
import type { IdentityCapture } from "@recnrun/domain";
import { sampleCapture } from "@recnrun/domain/testing";
import { createIdentityCaptures } from "@/storage/identity-captures";
import type { CapturePart } from "@/storage/identity-captures";
import { settled } from "./origin-storage";

const DATABASE = "recnrun-identity-captures";
const ORIGIN = "http://app.localhost:5192";

beforeEach(async () => {
  // A repository left open closes on `versionchange`, so the delete is never blocked.
  await settled(indexedDB.deleteDatabase(DATABASE));
});

/**
 * The sample as `id`, with every store's records, then every cache, moved out into parts, as a
 * capture writes them.
 */
function split(id: string, overrides: Partial<IdentityCapture> = {}) {
  const capture = { ...sampleCapture(), id, ...overrides };
  const parts: CapturePart[] = [];
  const origins = capture.origins.map((origin) => ({
    ...origin,
    caches: [],
    indexedDB: origin.indexedDB.map((database) => ({
      ...database,
      stores: database.stores.map((store) => {
        if (store.records.length > 0) {
          parts.push({
            origin: origin.origin,
            database: database.name,
            store: store.name,
            records: store.records,
          });
        }
        return { ...store, records: [] };
      }),
    })),
  }));
  for (const { origin, caches } of capture.origins) {
    for (const cache of caches) parts.push({ origin, cache });
  }
  const complete: IdentityCapture = { ...capture, origins };
  const { endedAt: _, ...rest } = complete;
  const started: IdentityCapture = { ...rest, status: "in-progress" };
  return { capture, complete, started, parts };
}

/** Writes a whole capture through the repository and publishes it, tentatively when asked. */
async function store(
  repository: ReturnType<typeof createIdentityCaptures>,
  id: string,
  tentative = false,
) {
  const { capture, complete, started, parts } = split(id);
  await repository.begin(started);
  for (const part of parts) await repository.append(id, part);
  await repository.publish(complete, { tentative });
  return capture;
}

/** How many rows each of the repository's object stores holds. */
async function rowCounts() {
  const connection = await settled(indexedDB.open(DATABASE));
  try {
    const names = [...connection.objectStoreNames];
    const transaction = connection.transaction(names);
    const counts = await Promise.all(
      names.map((name) => settled(transaction.objectStore(name).count())),
    );
    return Object.fromEntries(names.map((name, index) => [name, counts[index]]));
  } finally {
    connection.close();
  }
}

test("reads back a published capture whole, with its parts in order and their types intact", async () => {
  const repository = createIdentityCaptures(indexedDB);
  expect(await repository.read("identity-a")).toBeNull();
  const capture = await store(repository, "capture-1");

  const read = await repository.read("identity-a");
  expect(read).toEqual(capture);
  const orders = read?.origins[0]?.indexedDB[0]?.stores[1]?.records[0]?.value as {
    at: unknown;
    lines: unknown;
  };
  expect(orders.at).toBeInstanceOf(Date);
  expect(orders.lines).toBeInstanceOf(Map);
  expect(read?.origins[0]?.caches[0]?.entries[0]?.response.body).toBeInstanceOf(ArrayBuffer);
});

test("an interrupted write leaves the previous capture readable, from a fresh repository too", async () => {
  const first = createIdentityCaptures(indexedDB);
  const previous = await store(first, "capture-1");
  const { started, parts } = split("capture-2");
  await first.begin(started);
  await first.append("capture-2", parts[0] as CapturePart);
  // A function cannot be cloned, so the write fails as a page value Chrome refuses would.
  const refused = { ...parts[1], records: [{ key: 9, value: () => undefined }] } as CapturePart;
  await expect(first.append("capture-2", refused)).rejects.toMatchObject({
    name: "DataCloneError",
  });

  expect(await first.read("identity-a")).toEqual(previous);
  // A service worker that stopped mid-capture comes back to the same published capture.
  expect(await createIdentityCaptures(indexedDB).read("identity-a")).toEqual(previous);
});

test("readers never see a capture before it is published", async () => {
  const repository = createIdentityCaptures(indexedDB);
  const { started, parts } = split("capture-1");
  await repository.begin(started);
  for (const part of parts) await repository.append("capture-1", part);
  expect(await repository.read("identity-a")).toBeNull();
});

test("a publish that does not validate changes nothing", async () => {
  const repository = createIdentityCaptures(indexedDB);
  const previous = await store(repository, "capture-1");
  const { started, complete, parts } = split("capture-2");
  await repository.begin(started);
  await repository.append("capture-2", { ...(parts[0] as CapturePart), store: "missing" });

  await expect(repository.publish(complete)).rejects.toThrow(/lacks/);
  await expect(repository.publish({ ...complete, endedAt: undefined })).rejects.toThrow();
  expect(await repository.read("identity-a")).toEqual(previous);
});

test("a cache part must name the capture's origin and hold entries a page can rebuild", async () => {
  const repository = createIdentityCaptures(indexedDB);
  const { started, complete, parts } = split("capture-1");
  const cachePart = parts.at(-1) as Extract<CapturePart, { cache: unknown }>;
  const [entry] = cachePart.cache.entries;
  const opaque = { ...entry, response: { ...entry?.response, status: 0 } };
  for (const [part, error] of [
    [{ ...cachePart, origin: "http://other.localhost:5192" }, /lacks/],
    [{ ...cachePart, cache: { name: "v1", entries: [opaque] } }, /schema/],
  ] as const) {
    await repository.discard("capture-1").catch(() => undefined);
    await repository.begin(started);
    await repository.append("capture-1", part as CapturePart);
    await expect(repository.publish(complete)).rejects.toThrow(error);
  }
  expect(await repository.read("identity-a")).toBeNull();
});

test("publishing removes the previous capture and abandoned ones with all their parts", async () => {
  const repository = createIdentityCaptures(indexedDB);
  await store(repository, "capture-1");
  const abandoned = split("capture-2");
  await repository.begin(abandoned.started);
  await repository.append("capture-2", abandoned.parts[0] as CapturePart);
  const otherSplit = split("capture-9", { identityId: "identity-b" });
  await repository.begin(otherSplit.started);
  for (const part of otherSplit.parts) await repository.append("capture-9", part);
  await repository.publish(otherSplit.complete);

  const latest = await store(repository, "capture-3");
  expect(await repository.read("identity-a")).toEqual(latest);
  expect(await repository.read("identity-b")).toEqual(otherSplit.capture);
  // One capture per identity, its two record parts and one cache part each, and one pointer each.
  expect(await rowCounts()).toEqual({ captures: 2, parts: 6, pointers: 2 });
  await expect(repository.append("capture-2", abandoned.parts[0] as CapturePart)).rejects.toThrow(
    /not in progress/,
  );
});

test("a tentative publish keeps the previous capture until it is settled on the new one", async () => {
  const repository = createIdentityCaptures(indexedDB);
  await store(repository, "capture-1");
  const latest = await store(repository, "capture-2", true);
  expect(await repository.read("identity-a")).toEqual(latest);
  expect(await rowCounts()).toEqual({ captures: 2, parts: 6, pointers: 1 });
  await expect(store(repository, "capture-3")).rejects.toThrow(/not settled/);
  await repository.settle("identity-a", "capture-2");
  expect(await repository.read("identity-a")).toEqual(latest);
  expect(await rowCounts()).toEqual({ captures: 1, parts: 3, pointers: 1 });
  // Settled, the pointer no longer changes on a later settle.
  await repository.settle("identity-a", "capture-1");
  expect(await repository.read("identity-a")).toEqual(latest);
});

test("settling a tentative publish on another capture puts the previous one back", async () => {
  const repository = createIdentityCaptures(indexedDB);
  const first = await store(repository, "capture-1");
  await store(repository, "capture-2", true);
  await repository.settle("identity-a", "capture-1");
  expect(await repository.read("identity-a")).toEqual(first);
  expect(await rowCounts()).toEqual({ captures: 1, parts: 3, pointers: 1 });
  await store(repository, "capture-3", true);
  await repository.remove("identity-a");
  await store(repository, "capture-4", true);
  await repository.settle("identity-a", undefined);
  await repository.settle("identity-z", undefined);
  expect(await repository.read("identity-a")).toBeNull();
  expect(await rowCounts()).toEqual({ captures: 0, parts: 0, pointers: 0 });
});

test("a published capture takes no more parts and cannot be discarded", async () => {
  const repository = createIdentityCaptures(indexedDB);
  const { parts } = split("capture-1");
  await store(repository, "capture-1");
  await expect(repository.append("capture-1", parts[0] as CapturePart)).rejects.toThrow(
    /not in progress/,
  );
  await expect(repository.discard("capture-1")).rejects.toThrow(/not in progress/);
  await expect(repository.begin(split("capture-1").started)).rejects.toMatchObject({
    name: "ConstraintError",
  });
});

test("discarding a capture in progress removes it and its parts", async () => {
  const repository = createIdentityCaptures(indexedDB);
  const { started, complete, parts } = split("capture-1");
  await repository.begin(started);
  await repository.append("capture-1", parts[0] as CapturePart);
  await repository.discard("capture-1");
  expect(await rowCounts()).toEqual({ captures: 0, parts: 0, pointers: 0 });
  await expect(repository.begin(complete)).rejects.toThrow(/must be in-progress/);
});

test("removing an identity deletes its capture, its parts, and its pointer", async () => {
  const repository = createIdentityCaptures(indexedDB);
  await store(repository, "capture-1");
  const { started, parts } = split("capture-2");
  await repository.begin(started);
  await repository.append("capture-2", parts[0] as CapturePart);
  await repository.remove("identity-a");
  expect(await repository.read("identity-a")).toBeNull();
  expect(await rowCounts()).toEqual({ captures: 0, parts: 0, pointers: 0 });
});

test("a stored row that no longer validates fails the read instead of returning part of it", async () => {
  const repository = createIdentityCaptures(indexedDB);
  await store(repository, "capture-1");
  const connection = await settled(indexedDB.open(DATABASE));
  const parts = connection.transaction("parts", "readwrite").objectStore("parts");
  const [key] = await settled(parts.getAllKeys());
  await settled(parts.put({ captureId: "capture-1", origin: ORIGIN, records: [] }, key));
  connection.close();
  await expect(repository.read("identity-a")).rejects.toThrow(/does not match/);
});

test("holds ten thousand records written in parts of a thousand", async () => {
  const repository = createIdentityCaptures(indexedDB);
  const { started, complete } = split("capture-1");
  await repository.begin(started);
  for (let page = 0; page < 10; page += 1) {
    const records = Array.from({ length: 1_000 }, (_, index) => ({
      key: page * 1_000 + index + 1,
      value: { at: new Date(index), bytes: new Uint8Array(16) },
    }));
    await repository.append("capture-1", {
      origin: ORIGIN,
      database: "shop",
      store: "orders",
      records,
    });
  }
  await repository.publish(complete);
  const orders = (await repository.read("identity-a"))?.origins[0]?.indexedDB[0]?.stores[1];
  expect(orders?.records).toHaveLength(10_000);
  expect(orders?.records.at(-1)?.key).toBe(10_000);
});

test("dropping an origin's parts leaves the other origins' parts, and only while in progress", async () => {
  const repository = createIdentityCaptures(indexedDB);
  const { capture, complete, started, parts } = split("capture-1");
  await repository.begin(started);
  for (const part of parts) await repository.append("capture-1", part);
  const other = { ...(parts[0] as CapturePart), origin: "http://other.localhost:5192" };
  await repository.append("capture-1", other);
  await repository.dropParts("capture-1", other.origin);
  expect((await rowCounts()).parts).toBe(parts.length);

  await repository.publish(complete);
  expect(await repository.read("identity-a")).toEqual(capture);
  await expect(repository.dropParts("capture-1", ORIGIN)).rejects.toThrow(/not in progress/);
});

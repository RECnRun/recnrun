import { IdentityCaptureSchema } from "@recnrun/domain";
import type { IdentityCapture } from "@recnrun/domain";
import * as v from "valibot";
import { request, transact } from "@/storage/indexed-db";

type Origin = IdentityCapture["origins"][number];
type StoreRecord = Origin["indexedDB"][number]["stores"][number]["records"][number];
type Cache = Origin["caches"][number];

/** One part of a capture: the records of one object store, or one whole cache. */
export type CapturePart =
  | { origin: string; database: string; store: string; records: StoreRecord[] }
  | { origin: string; cache: Cache };

const DATABASE = "recnrun-identity-captures";
const CAPTURES = "captures";
const PARTS = "parts";
const POINTERS = "pointers";
const BY_CAPTURE = "byCapture";
const BY_IDENTITY = "byIdentity";
const EVERY_STORE = [CAPTURES, PARTS, POINTERS];

const RecordsRowSchema = v.object({
  captureId: v.string(),
  origin: v.string(),
  database: v.string(),
  store: v.string(),
  records: v.array(v.unknown()),
});
const CacheRowSchema = v.object({
  captureId: v.string(),
  origin: v.string(),
  cache: v.object({ name: v.string(), entries: v.array(v.unknown()) }),
});
const PartRowSchema = v.union([RecordsRowSchema, CacheRowSchema]);
const PointerSchema = v.object({
  identityId: v.string(),
  captureId: v.string(),
  /** Set while a tentative publish awaits `settle`: the capture it replaced, or null for none. */
  previous: v.optional(v.nullable(v.string())),
});

type RecordsRow = v.InferOutput<typeof RecordsRowSchema>;

/** A refused repository call; the message names no stored value. */
class CaptureStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureStoreError";
  }
}

function parsed<S extends v.GenericSchema>(schema: S, row: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, row);
  if (!result.success) throw new CaptureStoreError("A stored capture does not match its schema.");
  return result.output;
}

function createSchema(connection: IDBDatabase): void {
  connection.createObjectStore(CAPTURES, { keyPath: "id" }).createIndex(BY_IDENTITY, "identityId");
  // An increasing key keeps a capture's parts in the order they were written.
  const parts = connection.createObjectStore(PARTS, { autoIncrement: true });
  parts.createIndex(BY_CAPTURE, "captureId");
  connection.createObjectStore(POINTERS, { keyPath: "identityId" });
}

function storeOf(origin: Origin | undefined, part: RecordsRow) {
  return origin?.indexedDB
    .find(({ name }) => name === part.database)
    ?.stores.find(({ name }) => name === part.store);
}

/** Copies every list a part may append to, so assembling never changes the stored header. */
function copyOrigin(origin: Origin): Origin {
  return {
    ...origin,
    indexedDB: origin.indexedDB.map((database) => ({
      ...database,
      stores: database.stores.map((store) => ({ ...store, records: [...store.records] })),
    })),
    caches: [...origin.caches],
  };
}

/**
 * The header with every part appended in the order it was written: records to their store, caches
 * to their origin. The whole capture is validated after.
 */
function assemble(header: IdentityCapture, parts: unknown[]): IdentityCapture {
  const origins = header.origins.map(copyOrigin);
  for (const part of parts.map((row) => parsed(PartRowSchema, row))) {
    const origin = origins.find(({ origin: name }) => name === part.origin);
    if ("cache" in part) {
      if (!origin) throw new CaptureStoreError("A part names an origin its capture lacks.");
      origin.caches.push(part.cache as Cache);
      continue;
    }
    const store = storeOf(origin, part);
    if (!store) throw new CaptureStoreError("A part names a store its capture lacks.");
    for (const record of part.records) store.records.push(record as StoreRecord);
  }
  return parsed(IdentityCaptureSchema, { ...header, origins });
}

async function headerOf(transaction: IDBTransaction, captureId: string) {
  const row: unknown = await request(transaction.objectStore(CAPTURES).get(captureId));
  return row === undefined ? undefined : parsed(IdentityCaptureSchema, row);
}

async function openHeader(transaction: IDBTransaction, captureId: string) {
  const header = await headerOf(transaction, captureId);
  if (header?.status !== "in-progress") {
    throw new CaptureStoreError("The capture is not in progress.");
  }
  return header;
}

function partsOf(transaction: IDBTransaction, captureId: string): Promise<unknown[]> {
  return request(transaction.objectStore(PARTS).index(BY_CAPTURE).getAll(captureId));
}

async function deleteCapture(transaction: IDBTransaction, captureId: IDBValidKey): Promise<void> {
  const parts = transaction.objectStore(PARTS);
  const keys = await request(parts.index(BY_CAPTURE).getAllKeys(captureId));
  await Promise.all(keys.map((key) => request(parts.delete(key))));
  await request(transaction.objectStore(CAPTURES).delete(captureId));
}

/** Deletes every capture of `identityId` but those in `keep`, whether published or abandoned. */
async function deleteCaptures(
  transaction: IDBTransaction,
  identityId: string,
  keep: readonly IDBValidKey[] = [],
) {
  const index = transaction.objectStore(CAPTURES).index(BY_IDENTITY);
  const ids = await request(index.getAllKeys(identityId));
  for (const id of ids) if (!keep.includes(id)) await deleteCapture(transaction, id);
}

function requireStatus(header: IdentityCapture, status: IdentityCapture["status"]): void {
  if (header.status !== status) throw new CaptureStoreError(`The capture must be ${status}.`);
}

/** Validates a header the background built, before any transaction starts. */
function validHeader(header: IdentityCapture, status: IdentityCapture["status"]) {
  const valid = parsed(IdentityCaptureSchema, header);
  requireStatus(valid, status);
  return valid;
}

async function pointerOf(transaction: IDBTransaction, identityId: string) {
  const row: unknown = await request(transaction.objectStore(POINTERS).get(identityId));
  return row === undefined ? undefined : parsed(PointerSchema, row);
}

/**
 * Completes a started capture and makes it the identity's only one, in the caller's transaction;
 * a tentative publish keeps the capture it replaces until `settle` decides between them.
 */
async function publishIn(transaction: IDBTransaction, header: IdentityCapture, tentative: boolean) {
  const started = await openHeader(transaction, header.id);
  if (started.identityId !== header.identityId) {
    throw new CaptureStoreError("The capture belongs to another identity.");
  }
  // Validating the whole capture here means a published pointer never names one `read` refuses.
  assemble(header, await partsOf(transaction, header.id));
  const current = await pointerOf(transaction, header.identityId);
  if (current?.previous !== undefined) {
    throw new CaptureStoreError("The identity's previous capture is not settled.");
  }
  await request(transaction.objectStore(CAPTURES).put(header));
  const previous = tentative ? { previous: current?.captureId ?? null } : {};
  const pointer = { identityId: header.identityId, captureId: header.id, ...previous };
  await request(transaction.objectStore(POINTERS).put(pointer));
  const kept = tentative && current ? [header.id, current.captureId] : [header.id];
  await deleteCaptures(transaction, header.identityId, kept);
}

/** Keeps the pointer's capture when it is `committedId`, else puts its previous one back. */
async function settleIn(transaction: IDBTransaction, identityId: string, committedId?: string) {
  const pointer = await pointerOf(transaction, identityId);
  if (pointer?.previous === undefined) return;
  const { captureId, previous } = pointer;
  const kept = captureId === committedId;
  const pointers = transaction.objectStore(POINTERS);
  if (kept) await request(pointers.put({ identityId, captureId }));
  else if (previous === null) await request(pointers.delete(identityId));
  else await request(pointers.put({ identityId, captureId: previous }));
  const survivor = kept ? captureId : previous;
  await deleteCaptures(transaction, identityId, survivor === null ? [] : [survivor]);
}

async function readIn(transaction: IDBTransaction, identityId: string) {
  const pointer = await pointerOf(transaction, identityId);
  if (pointer === undefined) return null;
  const { captureId } = pointer;
  const header = await headerOf(transaction, captureId);
  if (!header) throw new CaptureStoreError("The published capture is missing.");
  requireStatus(header, "complete");
  return assemble(header, await partsOf(transaction, captureId));
}

/** One open connection per repository, dropped when another context deletes or upgrades it. */
function connector(factory: IDBFactory): () => Promise<IDBDatabase> {
  let connecting: Promise<IDBDatabase> | undefined;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DATABASE, 1);
      opening.addEventListener("upgradeneeded", () => createSchema(opening.result));
      opening.addEventListener("success", () => resolve(opening.result));
      opening.addEventListener("error", () => reject(opening.error));
    });
  return () => {
    connecting ??= open().then((connection) => {
      connection.addEventListener("versionchange", () => {
        connection.close();
        connecting = undefined;
      });
      return connection;
    });
    connecting.catch(() => (connecting = undefined));
    return connecting;
  };
}

/**
 * Identity captures in the extension's IndexedDB, which keeps `Blob` and `Date` values as they are.
 * A capture is written in parts under its own id while the identity's pointer still names the
 * previous one; `publish` flips the pointer in one transaction, so readers see only complete
 * captures and an interrupted capture leaves the previous one readable.
 */
export function createIdentityCaptures(factory: IDBFactory) {
  const connect = connector(factory);
  const run = async <T>(mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>) =>
    transact(await connect(), EVERY_STORE, mode, body);

  return {
    /** Starts a capture: its in-progress header, under an id no other capture has used. */
    begin: async (header: IdentityCapture): Promise<void> => {
      const valid = validHeader(header, "in-progress");
      await run("readwrite", (tx) => request(tx.objectStore(CAPTURES).add(valid)));
    },
    /** Adds one store's records, or one cache, to a capture in progress, in its own transaction. */
    append: (captureId: string, part: CapturePart): Promise<void> =>
      run("readwrite", async (tx) => {
        await openHeader(tx, captureId);
        await request(tx.objectStore(PARTS).add({ ...part, captureId }));
      }),
    /** Completes a capture and makes it the identity's published one, or changes nothing. */
    publish: async (header: IdentityCapture, { tentative = false } = {}): Promise<void> => {
      const valid = validHeader(header, "complete");
      await run("readwrite", (tx) => publishIn(tx, valid, tentative));
    },
    /** Ends a tentative publish: keeps it if it is `committedId`, else restores the one before. */
    settle: (identityId: string, committedId: string | undefined): Promise<void> =>
      run("readwrite", (tx) => settleIn(tx, identityId, committedId)),
    /** Drops a capture in progress and its parts; a published capture stays. */
    discard: (captureId: string): Promise<void> =>
      run("readwrite", async (tx) => {
        await openHeader(tx, captureId);
        await deleteCapture(tx, captureId);
      }),
    /** The identity's published capture, whole and validated, or `null` when it has none. */
    read: (identityId: string): Promise<IdentityCapture | null> =>
      run("readonly", (tx) => readIn(tx, identityId)),
    /** Deletes every capture of the identity, its parts, and its pointer. */
    remove: (identityId: string): Promise<void> =>
      run("readwrite", async (tx) => {
        await deleteCaptures(tx, identityId);
        await request(tx.objectStore(POINTERS).delete(identityId));
      }),
  };
}

export type IdentityCaptures = ReturnType<typeof createIdentityCaptures>;

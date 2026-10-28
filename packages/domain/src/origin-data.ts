import * as v from "valibot";

/** Web Storage as captured: every key and value is a string. */
const StorageEntriesSchema = v.record(v.string(), v.string());

/** One record; `key` is present only for stores without an in-line key path. */
const StoreRecordSchema = v.object({ key: v.optional(v.unknown()), value: v.unknown() });

const ObjectStoreSchema = v.object({
  name: v.string(),
  keyPath: v.nullable(v.union([v.string(), v.array(v.string())])),
  autoIncrement: v.boolean(),
  records: v.array(StoreRecordSchema),
});

const DatabaseSchema = v.object({
  name: v.string(),
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  stores: v.array(ObjectStoreSchema),
});

/**
 * One origin's site data, as the origin agent restores it. Record values stay `unknown` and pass
 * through untouched, so `Date`, `Blob`, and `ArrayBuffer` values keep their type.
 */
export const OriginDataSchema = v.object({
  localStorage: StorageEntriesSchema,
  sessionStorage: StorageEntriesSchema,
  indexedDB: v.array(DatabaseSchema),
});

export type OriginData = v.InferOutput<typeof OriginDataSchema>;

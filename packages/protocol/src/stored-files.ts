import * as v from "valibot";
import { IdSchema, IsoTimestampSchema, NonEmptyStringSchema } from "./common.ts";
import {
  DatasetSchema,
  FLOW_STATUSES,
  FlowManifestSchema,
  RevisionHashSchema,
} from "./flow-folder.ts";
import {
  RUN_STATUSES,
  RunCoverageSchema,
  RunManifestSchema,
  RunStepsSchema,
  RunSummarySchema,
} from "./run.ts";

/** Why the flow store could not use a file; a listing skips the file and reports it. */
export const FLOW_STORE_ERROR_CODES = [
  "not-found",
  "unreadable",
  "not-json",
  "not-yaml",
  "invalid",
  "revision-mismatch",
  "revision-conflict",
  "run-exists",
] as const;

export type FlowStoreErrorCode = (typeof FLOW_STORE_ERROR_CODES)[number];

/** A row of the flow catalog, as the SQLite index lists it. */
export const FlowCatalogEntrySchema = v.strictObject({
  id: IdSchema,
  name: NonEmptyStringSchema,
  status: v.picklist(FLOW_STATUSES),
  revision: RevisionHashSchema,
  updatedAt: IsoTimestampSchema,
});

/** A row of the run catalog; a run with no summary yet is `running`. */
export const RunCatalogEntrySchema = v.strictObject({
  id: IdSchema,
  flowId: IdSchema,
  revision: RevisionHashSchema,
  status: v.picklist([...RUN_STATUSES, "running"]),
  startedAt: IsoTimestampSchema,
  finishedAt: v.nullable(IsoTimestampSchema),
});

/** A file the last rebuild of the index skipped, with the reason. */
export const StoreProblemSchema = v.strictObject({
  path: NonEmptyStringSchema,
  code: v.picklist(FLOW_STORE_ERROR_CODES),
  message: NonEmptyStringSchema,
});

export type FlowCatalogEntry = v.InferOutput<typeof FlowCatalogEntrySchema>;
export type RunCatalogEntry = v.InferOutput<typeof RunCatalogEntrySchema>;
export type StoreProblem = v.InferOutput<typeof StoreProblemSchema>;

const STORED_SHAPES = {
  "flow-manifest": FlowManifestSchema,
  dataset: DatasetSchema,
  "run-manifest": RunManifestSchema,
  "run-steps": RunStepsSchema,
  "run-coverage": RunCoverageSchema,
  "run-summary": RunSummarySchema,
  "flow-catalog-entry": FlowCatalogEntrySchema,
  "run-catalog-entry": RunCatalogEntrySchema,
  "store-problem": StoreProblemSchema,
} as const;

export type StoredShape = keyof typeof STORED_SHAPES;
export type Stored<K extends StoredShape> = v.InferOutput<(typeof STORED_SHAPES)[K]>;
export type StoredParse<K extends StoredShape> =
  | { ok: true; value: Stored<K> }
  | { ok: false; message: string };

/** Validates a value read from the flow store, so persistence checks it without importing Valibot. */
export function parseStored<K extends StoredShape>(shape: K, input: unknown): StoredParse<K> {
  const schema = STORED_SHAPES[shape] as v.GenericSchema<unknown, Stored<K>>;
  const parsed = v.safeParse(schema, input);
  if (parsed.success) return { ok: true, value: parsed.output };
  return { ok: false, message: v.summarize(parsed.issues) };
}

/** True for an id that is also a safe folder name: no separators, never `.` or `..`. */
export function isId(value: unknown): value is string {
  return v.is(IdSchema, value);
}

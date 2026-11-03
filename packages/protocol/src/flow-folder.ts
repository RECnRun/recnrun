import * as v from "valibot";
import { IdSchema, IsoTimestampSchema, NameSchema, NonEmptyStringSchema } from "./common.ts";
import { SchemaVersionSchema } from "./version.ts";

/** Where a flow stands (source plan §14); a recording is not a validated test by itself. */
export const FLOW_STATUSES = [
  "draft",
  "recorded",
  "validated",
  "incompatible",
  "needs-review",
] as const;

export type FlowStatus = (typeof FLOW_STATUSES)[number];

/** A revision is named by the sha256 of the flow's canonical JSON. */
export const RevisionHashSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{64}$/, "A revision is a sha256 hex digest."),
);

/** One save that changed the flow's current revision. */
export const RevisionRecordSchema = v.strictObject({
  revision: RevisionHashSchema,
  savedAt: IsoTimestampSchema,
});

function currentIsLatest<T extends { revision: string; revisions: { revision: string }[] }>(
  manifest: T,
): boolean {
  return manifest.revisions.at(-1)?.revision === manifest.revision;
}

/** flows/<id>/manifest.json: the flow's identity, current revision, status, and revision history. */
export const FlowManifestSchema = v.pipe(
  v.strictObject({
    schemaVersion: SchemaVersionSchema,
    id: IdSchema,
    name: NonEmptyStringSchema,
    revision: RevisionHashSchema,
    status: v.picklist(FLOW_STATUSES),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    // Oldest first; the last entry is the current revision.
    revisions: v.pipe(v.array(RevisionRecordSchema), v.minLength(1)),
  }),
  v.check(currentIsLatest, "The current revision is the last one in the history."),
);

/** flows/<id>/datasets/<name>.json: reusable input values; never secrets. */
export const DatasetSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  inputs: v.record(NameSchema, v.unknown()),
});

export type RevisionRecord = v.InferOutput<typeof RevisionRecordSchema>;
export type FlowManifest = v.InferOutput<typeof FlowManifestSchema>;
export type Dataset = v.InferOutput<typeof DatasetSchema>;

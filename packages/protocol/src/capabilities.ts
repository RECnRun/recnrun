import * as v from "valibot";
import { IdSchema, NonEmptyStringSchema } from "./common.ts";
import { SchemaVersionSchema } from "./version.ts";

/** Shared by the capability matrix and each run's coverage.json. */
export const CAPABILITY_STATUSES = ["implemented", "partial", "unavailable", "planned"] as const;

/** The capture surfaces of source plan §10. */
export const CAPTURE_SURFACES = [
  "dom-events",
  "navigation",
  "network",
  "websocket-sse",
  "console-errors",
  "dom-screen",
  "web-storage",
  "cookies",
  "indexeddb",
  "cache-storage",
  "files-opfs",
  "workers-frames",
] as const;

/** Capture levels of source plan §10. */
export const CAPTURE_LEVELS = ["normal", "deep"] as const;

export const CapabilityStatusSchema = v.picklist(CAPABILITY_STATUSES);
export const CaptureSurfaceSchema = v.picklist(CAPTURE_SURFACES);
export const CaptureLevelSchema = v.picklist(CAPTURE_LEVELS);
// The task of PLAN.md that changes the status next, such as `F3.4` or `F4A.1`.
export const PhaseSchema = v.pipe(v.string(), v.regex(/^F\d[A]?\.\d+$/, "A phase is a task id."));

const capabilityEntries = {
  title: NonEmptyStringSchema,
  status: CapabilityStatusSchema,
  phase: PhaseSchema,
  // One sentence with the honest limit, or the test or task that proves an implemented entry.
  notes: NonEmptyStringSchema,
};

/** One row of the matrix: a capture surface or a feature, with its status. */
export const CapabilitySchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("surface"),
    id: IdSchema,
    surface: CaptureSurfaceSchema,
    level: CaptureLevelSchema,
    ...capabilityEntries,
  }),
  v.strictObject({ kind: v.literal("feature"), id: IdSchema, ...capabilityEntries }),
]);

/** What this build can capture and do: `CAPABILITY_MATRIX` is the value, and `capabilities.get` returns it. */
export const CapabilityMatrixSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  capabilities: v.array(CapabilitySchema),
});

export type CapabilityStatus = v.InferOutput<typeof CapabilityStatusSchema>;
export type CaptureLevel = v.InferOutput<typeof CaptureLevelSchema>;
export type CaptureSurface = v.InferOutput<typeof CaptureSurfaceSchema>;
export type Capability = v.InferOutput<typeof CapabilitySchema>;
export type CapabilityMatrix = v.InferOutput<typeof CapabilityMatrixSchema>;

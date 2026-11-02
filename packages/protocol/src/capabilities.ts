import * as v from "valibot";
import { IdSchema } from "./common.ts";
import { SchemaVersionSchema } from "./version.ts";

/** Shared by the capability matrix and each run's coverage.json. */
export const CAPABILITY_STATUSES = ["implemented", "partial", "unavailable", "planned"] as const;

/** The capture surfaces of source plan §10. */
export const CAPTURE_SURFACES = [
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

export const PHASES = ["F0", "F1", "F2", "F3", "F4", "F4A", "F5", "F6", "F7"] as const;

export const CapabilityStatusSchema = v.picklist(CAPABILITY_STATUSES);
export const CaptureSurfaceSchema = v.picklist(CAPTURE_SURFACES);
export const PhaseSchema = v.picklist(PHASES);

const capabilityEntries = {
  status: CapabilityStatusSchema,
  // The phase of PLAN.md that changes this status next.
  phase: PhaseSchema,
  notes: v.optional(v.string()),
};

/** One row of the matrix: a capture surface or a feature, with its status. */
export const CapabilitySchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("surface"), id: CaptureSurfaceSchema, ...capabilityEntries }),
  v.strictObject({ kind: v.literal("feature"), id: IdSchema, ...capabilityEntries }),
]);

/** What this build can capture and do; F0.4 fills it, `capabilities.get` returns it. */
export const CapabilityMatrixSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  capabilities: v.array(CapabilitySchema),
});

export type CapabilityStatus = v.InferOutput<typeof CapabilityStatusSchema>;
export type CaptureSurface = v.InferOutput<typeof CaptureSurfaceSchema>;
export type Capability = v.InferOutput<typeof CapabilitySchema>;
export type CapabilityMatrix = v.InferOutput<typeof CapabilityMatrixSchema>;

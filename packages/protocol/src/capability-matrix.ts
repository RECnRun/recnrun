import * as v from "valibot";
import { CapabilityMatrixSchema } from "./capabilities.ts";
import { FEATURE_CAPABILITIES } from "./capability-features.ts";
import { ROADMAP_CAPABILITIES } from "./capability-roadmap.ts";
import { SURFACE_CAPABILITIES } from "./capability-surfaces.ts";

/** What this build can capture and do; docs/CAPABILITIES.md is generated from it. */
export const CAPABILITY_MATRIX = v.parse(CapabilityMatrixSchema, {
  schemaVersion: 1,
  capabilities: [...SURFACE_CAPABILITIES, ...FEATURE_CAPABILITIES, ...ROADMAP_CAPABILITIES],
});

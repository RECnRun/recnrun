import * as v from "valibot";
import { CountSchema, IdSchema, NonEmptyStringSchema } from "./common.ts";
import { GapPayloadSchema } from "./events.ts";
import { StepStateSchema } from "./states.ts";
import { SchemaVersionSchema } from "./version.ts";

/** Failure codes that blame the application under test (exit 1); any other code is a run error. */
export const APPLICATION_FAILURE_CODES = [
  "assertion-failed",
  "timeout",
  "ambiguous",
  "navigation-failed",
  "not-actionable",
] as const;

/**
 * Who a divergence points at: the application, the collector that lost events (never the
 * application), or the replay itself (a step cut short, cancelled, or failing on its own).
 */
export const DIVERGENCE_KINDS = ["application", "collector-gap", "replay"] as const;

/** What differed first between the two runs. */
export const DIVERGENCE_REASONS = [
  "step-status",
  "assertion-failed",
  "network-status",
  "collector-gap",
] as const;

/** One run's side of a divergence: the step's result, or the event that differed. */
export const DivergenceSideSchema = v.strictObject({
  status: v.optional(StepStateSchema),
  error: v.optional(v.strictObject({ code: NonEmptyStringSchema, message: NonEmptyStringSchema })),
  eventId: v.optional(NonEmptyStringSchema),
  url: v.optional(v.string()),
  httpStatus: v.optional(v.pipe(v.number(), v.integer())),
  gap: v.optional(GapPayloadSchema),
});

const isGapReason = (reason: string) => reason === "collector-gap";

/** The first observable difference; a collector gap is always its own kind. */
export const RunDivergenceSchema = v.pipe(
  v.strictObject({
    kind: v.picklist(DIVERGENCE_KINDS),
    reason: v.picklist(DIVERGENCE_REASONS),
    stepId: v.optional(IdSchema),
    index: v.optional(CountSchema),
    message: NonEmptyStringSchema,
    baseline: DivergenceSideSchema,
    run: DivergenceSideSchema,
  }),
  v.check(
    ({ kind, reason }) => (kind === "collector-gap") === isGapReason(reason),
    "A collector gap is reported as kind collector-gap, and only a gap is.",
  ),
);

/** The result of `run.compare`: both runs aligned step by step, and where they first diverge. */
export const RunComparisonSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  baselineRunId: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  flowId: IdSchema,
  sameRevision: v.boolean(),
  steps: v.array(
    v.strictObject({
      stepId: IdSchema,
      index: CountSchema,
      baseline: v.optional(StepStateSchema),
      run: v.optional(StepStateSchema),
    }),
  ),
  divergence: v.nullable(RunDivergenceSchema),
});

export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];
export type DivergenceSide = v.InferOutput<typeof DivergenceSideSchema>;
export type RunDivergence = v.InferOutput<typeof RunDivergenceSchema>;
export type RunComparison = v.InferOutput<typeof RunComparisonSchema>;

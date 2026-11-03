import * as v from "valibot";
import { CapabilityStatusSchema, CaptureSurfaceSchema } from "./capabilities.ts";
import {
  CountSchema,
  IdSchema,
  IsoTimestampSchema,
  NameSchema,
  NonEmptyStringSchema,
} from "./common.ts";
import { RevisionHashSchema } from "./flow-folder.ts";
import { StepStateSchema } from "./states.ts";
import type { Step } from "./steps.ts";
import { SchemaVersionSchema } from "./version.ts";

export const RUN_STATUSES = ["passed", "failed", "error", "interrupted"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** The CLI exit code of each run status; an interrupted run is neither a pass nor a failure. */
export const RUN_EXIT_CODES: Readonly<Record<RunStatus, 0 | 1 | 2>> = {
  passed: 0,
  failed: 1,
  error: 2,
  interrupted: 2,
};

const runEntries = { schemaVersion: SchemaVersionSchema, runId: NonEmptyStringSchema };

const EvidenceSchema = v.array(NonEmptyStringSchema);

/** runs/<id>/manifest.json: what ran, on which revision, with which versions. */
export const RunManifestSchema = v.strictObject({
  ...runEntries,
  flowId: IdSchema,
  flowRevision: RevisionHashSchema,
  startedAt: IsoTimestampSchema,
  captureLevel: v.picklist(["normal", "deep"]),
  dataset: v.optional(NonEmptyStringSchema),
  versions: v.strictObject({
    engine: NonEmptyStringSchema,
    protocol: SchemaVersionSchema,
    chrome: v.optional(NonEmptyStringSchema),
    node: v.optional(NonEmptyStringSchema),
    playwright: v.optional(NonEmptyStringSchema),
  }),
  // Actor to the friendly name of the local binding; never a path or a profile id.
  bindings: v.record(NameSchema, NonEmptyStringSchema),
});

/** One executed instance of a step; `stepPath` and `iterationId` tell loop iterations apart. */
export const StepResultSchema = v.strictObject({
  stepId: IdSchema,
  stepPath: v.optional(v.array(IdSchema)),
  iterationId: v.optional(NonEmptyStringSchema),
  status: StepStateSchema,
  startedAt: v.optional(IsoTimestampSchema),
  endedAt: v.optional(IsoTimestampSchema),
  durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
  // Reads of the page before acting or deciding; a write action is dispatched at most once.
  attempts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  error: v.optional(v.strictObject({ code: NonEmptyStringSchema, message: NonEmptyStringSchema })),
  evidence: v.optional(EvidenceSchema),
});

/** runs/<id>/steps.json. */
export const RunStepsSchema = v.strictObject({ ...runEntries, steps: v.array(StepResultSchema) });

/** One surface of runs/<id>/coverage.json, with the reasons behind a status below `implemented`. */
export const CoverageEntrySchema = v.strictObject({
  surface: CaptureSurfaceSchema,
  status: CapabilityStatusSchema,
  reasons: v.array(NonEmptyStringSchema),
  gaps: v.optional(CountSchema),
  lostEvents: v.optional(CountSchema),
});

/** runs/<id>/coverage.json. */
export const RunCoverageSchema = v.strictObject({
  ...runEntries,
  surfaces: v.array(CoverageEntrySchema),
});

/** True when the exit code is the one `RUN_EXIT_CODES` gives the status. */
export function exitCodeMatchesStatus<T extends { status: RunStatus; exitCode: number }>(
  summary: T,
): boolean {
  return RUN_EXIT_CODES[summary.status] === summary.exitCode;
}

/** runs/<id>/summary.json. */
export const RunSummarySchema = v.pipe(
  v.strictObject({
    ...runEntries,
    flowId: IdSchema,
    status: v.picklist(RUN_STATUSES),
    exitCode: v.picklist([0, 1, 2]),
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema,
    counts: v.strictObject({
      total: CountSchema,
      pending: CountSchema,
      running: CountSchema,
      passed: CountSchema,
      failed: CountSchema,
      blocked: CountSchema,
      cancelled: CountSchema,
      indeterminate: CountSchema,
    }),
    failures: v.array(
      v.strictObject({
        stepId: IdSchema,
        message: NonEmptyStringSchema,
        evidence: v.optional(EvidenceSchema),
      }),
    ),
  }),
  v.check(exitCodeMatchesStatus, "The exit code does not match the run status."),
);

export type RunManifest = v.InferOutput<typeof RunManifestSchema>;
export type RunSteps = v.InferOutput<typeof RunStepsSchema>;
export type RunCoverage = v.InferOutput<typeof RunCoverageSchema>;
export type RunSummary = v.InferOutput<typeof RunSummarySchema>;

export type StepResult = v.InferOutput<typeof StepResultSchema>;

/** True when `value` is one entry of runs/<id>/steps.json; the engine checks its results with it. */
export function isStepResult(value: unknown): value is StepResult {
  return v.is(StepResultSchema, value);
}

/** The actions that only read the page: a run cut short in one of them changed nothing. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "waitFor",
  "extractText",
  "extractAttribute",
]);

/** True when `step` only reads the page; recovery calls any other interrupted step indeterminate. */
export function isReadOnlyStep(step: Step): boolean {
  if ("assertion" in step) return true;
  return "action" in step && READ_ONLY_ACTIONS.has(step.action);
}

import * as v from "valibot";
import {
  type ActionStep,
  ActionStepSchema,
  type AssertionStep,
  AssertionStepSchema,
} from "./actions.ts";
import {
  ArgsSchema,
  CountSchema,
  FunctionCallSchema,
  FunctionRefSchema,
  NameSchema,
  STEP_BASE_ENTRIES,
  ScalarSchema,
  TimeoutMsSchema,
} from "./common.ts";
import { StringWithInterpolationSchema as Text } from "./interpolation.ts";

/** The control blocks of source plan §9.3; F4A refines their runtime semantics. */
export const BUILTIN_NAMES = [
  "if",
  "repeat",
  "forEach",
  "while",
  "until",
  "counter",
  "setVariable",
  "call",
  "break",
  "continue",
] as const;

const IterationsSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const ifEntries = { ...STEP_BASE_ENTRIES, builtin: v.literal("if"), condition: FunctionCallSchema };
const repeatEntries = { ...STEP_BASE_ENTRIES, builtin: v.literal("repeat"), times: CountSchema };
const forEachEntries = {
  ...STEP_BASE_ENTRIES,
  builtin: v.literal("forEach"),
  items: v.union([Text, v.array(ScalarSchema)]),
  itemAs: NameSchema,
  indexAs: v.optional(NameSchema),
  maxIterations: IterationsSchema,
  timeoutMs: TimeoutMsSchema,
};
const conditionalLoopEntries = {
  ...STEP_BASE_ENTRIES,
  builtin: v.picklist(["while", "until"]),
  condition: FunctionCallSchema,
  maxIterations: IterationsSchema,
  timeoutMs: TimeoutMsSchema,
};

const FlatBuiltinStepSchema = v.variant("builtin", [
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    builtin: v.literal("counter"),
    operation: v.picklist(["init", "increment", "decrement", "get"]),
    name: NameSchema,
    value: v.optional(v.number()),
    by: v.optional(v.number()),
    saveAs: v.optional(NameSchema),
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    builtin: v.literal("setVariable"),
    name: NameSchema,
    value: ScalarSchema,
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    builtin: v.literal("call"),
    functionRef: FunctionRefSchema,
    args: v.optional(ArgsSchema),
    saveAs: v.optional(NameSchema),
  }),
  v.strictObject({ ...STEP_BASE_ENTRIES, builtin: v.picklist(["break", "continue"]) }),
]);

// Block heads without their nested steps, so the recursive type below is inferred.
type Head<TEntries extends v.ObjectEntries> = v.InferOutput<
  v.StrictObjectSchema<TEntries, undefined>
>;
type Nested = { steps: Step[] };

export type BuiltinStep =
  | (Head<typeof ifEntries> & { then: Step[]; else?: Step[] | undefined })
  | (Head<typeof repeatEntries> & Nested)
  | (Head<typeof forEachEntries> & Nested)
  | (Head<typeof conditionalLoopEntries> & Nested)
  | v.InferOutput<typeof FlatBuiltinStepSchema>;

export type Step = ActionStep | AssertionStep | BuiltinStep;

const StepListSchema: v.GenericSchema<unknown, Step[]> = v.array(v.lazy(() => StepSchema));

/** A control block step. Loops declare their iteration limit and deadline up front. */
export const BuiltinStepSchema = v.variant("builtin", [
  v.strictObject({ ...ifEntries, then: StepListSchema, else: v.optional(StepListSchema) }),
  v.strictObject({ ...repeatEntries, steps: StepListSchema }),
  v.strictObject({ ...forEachEntries, steps: StepListSchema }),
  v.strictObject({ ...conditionalLoopEntries, steps: StepListSchema }),
  ...FlatBuiltinStepSchema.options,
]);

/** Any step of a flow: an action, an assertion, or a control block that nests steps. */
export const StepSchema: v.GenericSchema<unknown, Step> = v.union([
  ActionStepSchema,
  AssertionStepSchema,
  BuiltinStepSchema,
]);

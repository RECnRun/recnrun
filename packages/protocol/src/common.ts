import * as v from "valibot";
import { StringWithInterpolationSchema } from "./interpolation.ts";

/** Ids of flows, steps, requirements, and locators: readable slugs such as `obter-id` or `CA-01`. */
export const ID_PATTERN = /^[A-Za-z0-9][\w.-]*$/;
export const ID_PROBLEM = "An id starts with a letter or digit and has no spaces.";
export const IdSchema = v.pipe(v.string(), v.regex(ID_PATTERN, ID_PROBLEM));

/** Names of actors, inputs, variables, and locals: identifiers that interpolation can read. */
export const NAME_PATTERN = /^[A-Za-z_]\w*$/;
export const NAME_PROBLEM = "A name is an identifier (letters, digits, underscore).";
export const NameSchema = v.pipe(v.string(), v.regex(NAME_PATTERN, NAME_PROBLEM));

/** A registered function pinned to an exact version, such as `team.canApprove@1.0.0`. */
export const FunctionRefSchema = v.pipe(
  v.string(),
  v.regex(
    /^[a-z][\w-]*(\.[A-Za-z_][\w-]*)+@\d+\.\d+\.\d+$/,
    "A function reference is <namespace>.<name>@<major>.<minor>.<patch>.",
  ),
);

export const TimeoutMsSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

export const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

export const IsoTimestampSchema = v.pipe(v.string(), v.isoTimestamp());

export const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty());

/** A scalar argument or value; strings may interpolate. */
export const ScalarSchema = v.union([
  StringWithInterpolationSchema,
  v.number(),
  v.boolean(),
  v.null(),
]);

/** Typed arguments passed to a registered function. */
export const ArgsSchema = v.record(NameSchema, ScalarSchema);

/** A call to a registered function: a locator, a predicate, a transform, or a macro. */
export const FunctionCallSchema = v.strictObject({
  functionRef: FunctionRefSchema,
  args: v.optional(ArgsSchema),
});

/** Fields every step carries, whatever its kind. */
export const STEP_BASE_ENTRIES = {
  id: IdSchema,
  actor: v.optional(NameSchema),
  description: v.optional(v.string()),
  timeoutMs: v.optional(TimeoutMsSchema),
  requirements: v.optional(v.array(IdSchema)),
};

import * as v from "valibot";
import { FunctionCallSchema, IdSchema, NameSchema, NonEmptyStringSchema } from "./common.ts";
import { StringWithInterpolationSchema as Text } from "./interpolation.ts";
import { TargetSchema } from "./locators.ts";
import { StepSchema } from "./steps.ts";
import { SchemaVersionSchema } from "./version.ts";

export const INPUT_TYPES = ["string", "number", "boolean", "array", "object"] as const;

/** A portable role such as `solicitante`; the local service binds it to a Chrome profile. */
export const ActorSchema = v.strictObject({ description: v.optional(v.string()) });

export const InputSchema = v.strictObject({
  type: v.picklist(INPUT_TYPES),
  required: v.optional(v.boolean(), false),
  default: v.optional(v.unknown()),
  // A secret input is resolved from the local store at run time and never written to a dataset.
  secret: v.optional(v.boolean()),
  description: v.optional(v.string()),
});

export const RequirementSchema = v.strictObject({
  id: IdSchema,
  text: NonEmptyStringSchema,
  source: v.optional(v.string()),
});

/** How a precondition is proved before any step runs: a URL, a visible element, or a function. */
export const PreconditionCheckSchema = v.union([
  v.strictObject({ url: Text }),
  v.strictObject({ visible: TargetSchema }),
  FunctionCallSchema,
]);

export const PreconditionSchema = v.strictObject({
  authenticated: NameSchema,
  check: PreconditionCheckSchema,
});

/** A declarative flow (source plan §9): what to do, never the evidence of doing it. */
export const FlowSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  name: NonEmptyStringSchema,
  description: v.optional(v.string()),
  actors: v.optional(v.record(NameSchema, ActorSchema), () => ({})),
  inputs: v.optional(v.record(NameSchema, InputSchema), () => ({})),
  requirements: v.optional(v.array(RequirementSchema), () => []),
  preconditions: v.optional(v.array(PreconditionSchema), () => []),
  steps: v.array(StepSchema),
});

export type Flow = v.InferOutput<typeof FlowSchema>;

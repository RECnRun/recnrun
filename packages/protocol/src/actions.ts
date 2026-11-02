import * as v from "valibot";
import { CountSchema, NameSchema, STEP_BASE_ENTRIES } from "./common.ts";
import { StringWithInterpolationSchema as Text } from "./interpolation.ts";
import { TargetSchema } from "./locators.ts";

/** The actions of PLAN.md F2.5, plus the extractions that save a variable. */
export const ACTION_NAMES = [
  "navigate",
  "reload",
  "click",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "keyPress",
  "scroll",
  "openTab",
  "selectTab",
  "closeTab",
  "waitFor",
  "extractText",
  "extractAttribute",
] as const;

/** The assertions of PLAN.md F2.5. */
export const ASSERTION_NAMES = [
  "visible",
  "hidden",
  "textEquals",
  "textContains",
  "value",
  "enabled",
  "disabled",
  "count",
  "url",
] as const;

const optionalTarget = v.optional(TargetSchema);

/** An action step; each action has the fields it needs, F2.5 defines their runtime semantics. */
export const ActionStepSchema = v.variant("action", [
  v.strictObject({ ...STEP_BASE_ENTRIES, action: v.literal("navigate"), url: Text }),
  v.strictObject({ ...STEP_BASE_ENTRIES, action: v.literal("openTab"), url: v.optional(Text) }),
  v.strictObject({ ...STEP_BASE_ENTRIES, action: v.picklist(["reload", "closeTab"]) }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    action: v.literal("selectTab"),
    tab: v.union([CountSchema, Text]),
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    action: v.picklist(["click", "check", "uncheck"]),
    target: TargetSchema,
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    action: v.picklist(["fill", "type", "select"]),
    target: TargetSchema,
    value: Text,
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    action: v.literal("keyPress"),
    key: v.pipe(v.string(), v.nonEmpty()),
    target: optionalTarget,
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    action: v.literal("scroll"),
    target: optionalTarget,
    deltaX: v.optional(v.number()),
    deltaY: v.optional(v.number()),
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    action: v.literal("waitFor"),
    target: optionalTarget,
    state: v.optional(v.picklist(["visible", "hidden", "attached", "detached"])),
    url: v.optional(Text),
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    action: v.literal("extractText"),
    target: TargetSchema,
    saveAs: NameSchema,
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    action: v.literal("extractAttribute"),
    target: TargetSchema,
    attribute: v.pipe(v.string(), v.nonEmpty()),
    saveAs: NameSchema,
  }),
]);

/** An assertion step; `requirements` links it to the criteria it covers. */
export const AssertionStepSchema = v.variant("assertion", [
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    assertion: v.picklist(["visible", "hidden", "enabled", "disabled"]),
    target: TargetSchema,
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    assertion: v.picklist(["textEquals", "textContains", "value"]),
    target: TargetSchema,
    expected: Text,
  }),
  v.strictObject({
    ...STEP_BASE_ENTRIES,
    assertion: v.literal("count"),
    target: TargetSchema,
    expected: CountSchema,
  }),
  v.strictObject({ ...STEP_BASE_ENTRIES, assertion: v.literal("url"), expected: Text }),
]);

export type ActionStep = v.InferOutput<typeof ActionStepSchema>;
export type AssertionStep = v.InferOutput<typeof AssertionStepSchema>;

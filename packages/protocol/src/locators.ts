import * as v from "valibot";
import {
  ArgsSchema,
  CountSchema,
  FunctionCallSchema,
  FunctionRefSchema,
  IdSchema,
  TimeoutMsSchema,
} from "./common.ts";
import { StringWithInterpolationSchema as Text } from "./interpolation.ts";

export const LOCATOR_STRATEGIES = [
  "testId",
  "role",
  "text",
  "label",
  "css",
  "xpath",
  "function",
] as const;

/** `orderedFallback` advances only on `not-found`; `agreement` requires every match to agree. */
export const RESOLUTION_POLICIES = ["orderedFallback", "agreement"] as const;

export const CARDINALITIES = ["one", "many", "optional", "nth"] as const;

/** The one-key form of the source plan's examples, such as `{ role: button, name: Criar }`. */
export const LocatorShorthandSchema = v.union([
  v.strictObject({ testId: Text }),
  v.strictObject({ role: v.string(), name: v.optional(Text), exact: v.optional(v.boolean()) }),
  v.strictObject({ text: Text, exact: v.optional(v.boolean()) }),
  v.strictObject({ label: Text, exact: v.optional(v.boolean()) }),
  v.strictObject({ css: Text }),
  v.strictObject({ xpath: Text }),
  FunctionCallSchema,
]);

export const LocatorFilterSchema = v.strictObject({
  hasText: v.optional(Text),
  hasNotText: v.optional(Text),
  visible: v.optional(v.boolean()),
});

const roleEntries = {
  strategy: v.literal("role"),
  role: v.string(),
  name: v.optional(Text),
  exact: v.optional(v.boolean()),
};
const textEntries = {
  strategy: v.picklist(["text", "label"]),
  value: Text,
  exact: v.optional(v.boolean()),
};
const selectorEntries = { strategy: v.picklist(["testId", "css", "xpath"]), value: Text };
const functionEntries = {
  strategy: v.literal("function"),
  functionRef: FunctionRefSchema,
  args: v.optional(ArgsSchema),
};

// Without composition, so the recursive type below is inferred instead of written by hand.
const LocatorHeadSchema = v.variant("strategy", [
  v.strictObject(roleEntries),
  v.strictObject(textEntries),
  v.strictObject(selectorEntries),
  v.strictObject(functionEntries),
]);

type LocatorComposition = {
  id?: string | undefined;
  within?: LocatorEntry | undefined;
  filter?: v.InferOutput<typeof LocatorFilterSchema> | undefined;
  has?: LocatorEntry | undefined;
};

export type LocatorEntry =
  | (v.InferOutput<typeof LocatorHeadSchema> & LocatorComposition)
  | v.InferOutput<typeof LocatorShorthandSchema>;

const NestedLocatorSchema: v.GenericSchema<unknown, LocatorEntry> = v.lazy(
  () => LocatorEntrySchema,
);

const compositionEntries = {
  id: v.optional(IdSchema),
  within: v.optional(NestedLocatorSchema),
  filter: v.optional(LocatorFilterSchema),
  has: v.optional(NestedLocatorSchema),
};

/** A locator with an explicit strategy and optional composition (`within`, `filter`, `has`). */
export const LocatorSchema = v.variant("strategy", [
  v.strictObject({ ...compositionEntries, ...roleEntries }),
  v.strictObject({ ...compositionEntries, ...textEntries }),
  v.strictObject({ ...compositionEntries, ...selectorEntries }),
  v.strictObject({ ...compositionEntries, ...functionEntries }),
]);

/** One item of a locator list: the explicit form or the shorthand. Recursive through composition. */
export const LocatorEntrySchema: v.GenericSchema<unknown, LocatorEntry> = v.union([
  LocatorSchema,
  LocatorShorthandSchema,
]);

/** `cardinality: nth` names which match it wants. */
export function nthHasIndex<T extends { cardinality: string; index?: number | undefined }>(
  list: T,
): boolean {
  return list.cardinality !== "nth" || list.index !== undefined;
}

/** Alternatives for one target, resolved under a single shared deadline (source plan §9.1). */
export const LocatorListSchema = v.pipe(
  v.strictObject({
    resolution: v.optional(v.picklist(RESOLUTION_POLICIES), "orderedFallback"),
    cardinality: v.optional(v.picklist(CARDINALITIES), "one"),
    index: v.optional(CountSchema),
    timeoutMs: v.optional(TimeoutMsSchema),
    locators: v.pipe(v.array(LocatorEntrySchema), v.minLength(1)),
  }),
  v.check(nthHasIndex, "cardinality: nth needs an index."),
);

/** A CSS selector string, a single locator, or a locator list. */
export const TargetSchema = v.union([Text, LocatorEntrySchema, LocatorListSchema]);

export type Target = v.InferOutput<typeof TargetSchema>;
export type LocatorList = v.InferOutput<typeof LocatorListSchema>;

import * as v from "valibot";
import { ArgsSchema, CountSchema, NonEmptyStringSchema, TimeoutMsSchema } from "./common.ts";
import { CARDINALITIES, nthHasIndex } from "./locators.ts";

/** What one locator strategy answers (source plan §9.1 rule 2). */
export const LOCATOR_STATUSES = [
  "matched",
  "not-found",
  "ambiguous",
  "unsupported",
  "error",
] as const;

export const LocatorStatusSchema = v.picklist(LOCATOR_STATUSES);

/**
 * An ephemeral reference to one element: the remote object is valid only on the CDP session that
 * resolved it and until its object group is released; `backendNodeId` survives across sessions.
 */
export const ElementReferenceSchema = v.strictObject({
  targetId: NonEmptyStringSchema,
  frameId: NonEmptyStringSchema,
  // CDP's id of the frame's current document; a navigation gives the frame a new one.
  loaderId: NonEmptyStringSchema,
  objectId: NonEmptyStringSchema,
  backendNodeId: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/** A JavaScript locator function run in an isolated world of one frame (the main frame by default). */
export const FunctionLocatorRequestSchema = v.pipe(
  v.strictObject({
    // A function expression called as `fn({ root }, args)`, `root` being the frame's document.
    source: NonEmptyStringSchema,
    cardinality: v.picklist(CARDINALITIES),
    index: v.optional(CountSchema),
    timeoutMs: TimeoutMsSchema,
    frameId: v.optional(NonEmptyStringSchema),
    args: v.optional(ArgsSchema),
  }),
  v.check(nthHasIndex, "cardinality: nth needs an index."),
);

/** What happened when the function outlived its timeout. */
export const LocatorDeadlineSchema = v.strictObject({
  timeoutMs: TimeoutMsSchema,
  // The renderer did not answer a probe at the deadline: synchronous code was still running.
  blocked: v.boolean(),
  // `Runtime.terminateExecution` was sent and Chrome answered it.
  terminated: v.boolean(),
  // The tab answered `Runtime.evaluate("1+1")` after the deadline was handled.
  tabResponsive: v.boolean(),
});

/** Only a matched result carries references; every other status has released its handles. */
export function onlyMatchedHasElements<T extends { status: string; elements: unknown[] }>(
  result: T,
): boolean {
  return result.status === "matched" || result.elements.length === 0;
}

export const FunctionLocatorResultSchema = v.pipe(
  v.strictObject({
    status: LocatorStatusSchema,
    cardinality: v.picklist(CARDINALITIES),
    // Distinct elements the function returned, before cardinality picked from them.
    count: CountSchema,
    elements: v.array(ElementReferenceSchema),
    durationMs: v.pipe(v.number(), v.minValue(0)),
    objectGroup: NonEmptyStringSchema,
    error: v.optional(v.strictObject({ message: NonEmptyStringSchema })),
    deadline: v.optional(LocatorDeadlineSchema),
  }),
  v.check(onlyMatchedHasElements, "Only a matched result carries element references."),
);

export type LocatorStatus = v.InferOutput<typeof LocatorStatusSchema>;
export type ElementReference = v.InferOutput<typeof ElementReferenceSchema>;
export type FunctionLocatorRequest = v.InferOutput<typeof FunctionLocatorRequestSchema>;
export type LocatorDeadline = v.InferOutput<typeof LocatorDeadlineSchema>;
export type FunctionLocatorResult = v.InferOutput<typeof FunctionLocatorResultSchema>;

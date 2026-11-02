import * as v from "valibot";
import { CapturedEventSchema } from "./capture.ts";
import { CountSchema, IdSchema, NameSchema, NonEmptyStringSchema } from "./common.ts";
import { LocatorListSchema } from "./locators.ts";

/** Test ids and element ids of the recorder overlay start with this; normalization drops their events. */
export const RECORDER_OVERLAY_PREFIX = "recnrun-overlay";

/** What a suggested step does; `dblclick` and `drag` have no flow action yet, the editor converts them. */
export const SUGGESTED_ACTIONS = [
  "navigate",
  "click",
  "dblclick",
  "drag",
  "fill",
  "type",
  "select",
  "keyPress",
  "scroll",
] as const;

/** Why normalization kept a raw event out of every suggested step. */
export const EXCLUSION_REASONS = [
  "replay-caused",
  "recorder-overlay",
  "untrusted",
  "scroll-dropped",
  "navigation-caused",
] as const;

/** A raw event a suggestion came from: its journal id with the producer and sequence that order it. */
export const EventRefSchema = v.strictObject({
  id: NonEmptyStringSchema,
  producer: NonEmptyStringSchema,
  seq: CountSchema,
});

const CoordinateSchema = v.pipe(v.number(), v.integer());

const suggestionEntries = {
  id: IdSchema,
  // From the session or binding of the event's producer, never from `isTrusted`.
  actor: v.optional(NameSchema),
  events: v.pipe(v.array(EventRefSchema), v.minLength(1)),
};

/** A step the recorder suggests from raw events; the person reviews it before it joins a flow. */
export const SuggestedStepSchema = v.variant("action", [
  v.strictObject({ ...suggestionEntries, action: v.literal("navigate"), url: v.string() }),
  v.strictObject({
    ...suggestionEntries,
    action: v.picklist(["click", "dblclick"]),
    target: LocatorListSchema,
  }),
  v.strictObject({
    ...suggestionEntries,
    action: v.literal("drag"),
    target: LocatorListSchema,
    to: LocatorListSchema,
  }),
  v.strictObject({
    ...suggestionEntries,
    action: v.picklist(["fill", "type", "select"]),
    target: LocatorListSchema,
    // A redacted field holds a `${secrets.<name>}` placeholder, never the typed value.
    value: v.string(),
    redacted: v.optional(v.literal(true)),
  }),
  v.strictObject({
    ...suggestionEntries,
    action: v.literal("keyPress"),
    key: NonEmptyStringSchema,
    target: v.optional(LocatorListSchema),
  }),
  v.strictObject({
    ...suggestionEntries,
    action: v.literal("scroll"),
    target: v.optional(LocatorListSchema),
    scrollX: CoordinateSchema,
    scrollY: CoordinateSchema,
  }),
]);

/** A raw event kept as evidence only; replay-caused events say so explicitly. */
export const ExcludedEventSchema = v.strictObject({
  event: EventRefSchema,
  reason: v.picklist(EXCLUSION_REASONS),
  replayCaused: v.optional(v.literal(true)),
});

/** What normalization returns: suggested steps in time order and the raw events it set aside. */
export const NormalizationResultSchema = v.strictObject({
  steps: v.array(SuggestedStepSchema),
  excluded: v.array(ExcludedEventSchema),
});

export type CheckedValue = { ok: true } | { ok: false; message: string };

function check(schema: v.GenericSchema, value: unknown): CheckedValue {
  const parsed = v.safeParse(schema, value);
  return parsed.success ? { ok: true } : { ok: false, message: v.summarize(parsed.issues) };
}

/** Checks a raw captured event for code that does not import Valibot (the engine and its tests). */
export const checkCapturedEvent = (value: unknown): CheckedValue =>
  check(CapturedEventSchema, value);

/** Checks a normalization result, so a golden expectation cannot drift from the protocol. */
export const checkNormalizationResult = (value: unknown): CheckedValue =>
  check(NormalizationResultSchema, value);

export type EventRef = v.InferOutput<typeof EventRefSchema>;
export type ExcludedEvent = v.InferOutput<typeof ExcludedEventSchema>;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
export type NormalizationResult = v.InferOutput<typeof NormalizationResultSchema>;
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];
export type SuggestedStep = v.InferOutput<typeof SuggestedStepSchema>;

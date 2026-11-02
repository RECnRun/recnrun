import * as v from "valibot";
import { CountSchema, IsoTimestampSchema, NonEmptyStringSchema } from "./common.ts";
import { CaptureSurfaceSchema } from "./capabilities.ts";
import { SchemaVersionSchema } from "./version.ts";

export const EVENT_CATEGORIES = [
  "action",
  "navigation",
  "network",
  "console",
  "error",
  "storage",
  "dom",
  "target",
  "connection",
  "locator",
  "function",
  "macro",
  "step",
] as const;

/** How an event is tied to a command; `temporal-only` says nothing more than "it came after". */
export const CAUSAL_CONFIDENCES = [
  "command-id",
  "initiator",
  "stack",
  "network-id",
  "temporal-only",
] as const;

/** Why events are missing; a gap is a collector fact, never an application failure. */
export const GAP_REASONS = [
  "buffer-exhausted",
  "connection-lost",
  "journal-truncated",
  "target-unattached",
  "producer-restarted",
] as const;

const PageIdSchema = v.nullable(NonEmptyStringSchema);

const envelopeEntries = {
  schemaVersion: SchemaVersionSchema,
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  // Sequence per producer; with `producer` it orders, deduplicates, and detects loss.
  seq: CountSchema,
  source: NonEmptyStringSchema,
  producer: NonEmptyStringSchema,
  timestamp: IsoTimestampSchema,
  monotonicTimeMs: v.optional(v.number()),
  receivedAt: v.optional(IsoTimestampSchema),
  // Never inferred from `isTrusted` (source plan §6).
  actor: v.optional(v.picklist(["human", "agent", "replay", "unknown"])),
  component: v.optional(v.picklist(["application", "browser", "collector", "engine"])),
  profileBinding: v.optional(NonEmptyStringSchema),
  targetId: PageIdSchema,
  frameId: PageIdSchema,
  documentId: PageIdSchema,
  stepId: v.optional(NonEmptyStringSchema),
  commandId: v.optional(v.nullable(NonEmptyStringSchema)),
  causalConfidence: v.optional(v.picklist(CAUSAL_CONFIDENCES)),
  type: NonEmptyStringSchema,
  // Large payloads live in blobs; the event keeps the reference.
  payloadRef: v.optional(NonEmptyStringSchema),
};

export const GapPayloadSchema = v.strictObject({
  reason: v.picklist(GAP_REASONS),
  surface: v.optional(CaptureSurfaceSchema),
  fromSeq: v.optional(CountSchema),
  toSeq: v.optional(CountSchema),
  lost: v.optional(CountSchema),
});

/** One journal line (source plan §11): an observed event or an explicit gap. */
export const EventSchema = v.variant("category", [
  v.strictObject({ ...envelopeEntries, category: v.literal("gap"), payload: GapPayloadSchema }),
  v.strictObject({
    ...envelopeEntries,
    category: v.picklist(EVENT_CATEGORIES),
    payload: v.record(v.string(), v.unknown()),
  }),
]);

export const EventCategorySchema = v.picklist([...EVENT_CATEGORIES, "gap"]);

export type Event = v.InferOutput<typeof EventSchema>;
export type GapPayload = v.InferOutput<typeof GapPayloadSchema>;

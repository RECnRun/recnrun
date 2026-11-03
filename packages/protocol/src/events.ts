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
  "snapshot",
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
  // The person or agent suspended capture (`suspendCapture`).
  "capture-suspended",
  // Stopping capture lost results it was still waiting for.
  "capture-stopped",
  // Observer messages that never reached the adapter, or that it rejected, and no resend recovered.
  "delivery-lost",
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

/** The §11 envelope fields, for schemas that type an event's category, type, and payload. */
export const EVENT_ENVELOPE_ENTRIES = envelopeEntries;

/** An event schema of one category and type: the §11 envelope with that type's payload. */
export const typedEvent = <
  const C extends string,
  const T extends string,
  P extends v.GenericSchema,
>(
  category: C,
  type: T,
  payload: P,
) =>
  v.strictObject({
    ...envelopeEntries,
    category: v.literal(category),
    type: v.literal(type),
    payload,
  });

export const GapPayloadSchema = v.strictObject({
  reason: v.picklist(GAP_REASONS),
  surface: v.optional(CaptureSurfaceSchema),
  // The producer whose sequence numbers `fromSeq` to `toSeq` are missing; the gap's own when absent.
  producer: v.optional(NonEmptyStringSchema),
  fromSeq: v.optional(CountSchema),
  toSeq: v.optional(CountSchema),
  lost: v.optional(CountSchema),
  // When the collector noticed the gap, and the last sequence it had seen before it.
  startedAt: v.optional(IsoTimestampSchema),
  lastSeq: v.optional(CountSchema),
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

/** The CDP signals that show another client already controls a target. */
export const CONTESTED_SIGNALS = ["attached-before-connect"] as const;

// Producer sequence, time, and the browser endpoint every adapter event carries.
const adapterEventEntries = {
  seq: CountSchema,
  at: IsoTimestampSchema,
  endpoint: NonEmptyStringSchema,
};

/** The CDP connection dropped (Chrome crashed, quit, or closed the socket); `gap` is a journal gap payload. */
export const ConnectionLostEventSchema = v.strictObject({
  type: v.literal("connection.lost"),
  ...adapterEventEntries,
  gap: v.strictObject({ ...GapPayloadSchema.entries, reason: v.literal("connection-lost") }),
});

/** Another debugger (DevTools or a second client) is attached to a target; RECnRun never detaches it. */
export const ControlContestedEventSchema = v.strictObject({
  type: v.literal("control.contested"),
  ...adapterEventEntries,
  targetId: NonEmptyStringSchema,
  url: v.string(),
  signal: v.picklist(CONTESTED_SIGNALS),
});

/** What the browser adapter reports about its connection, before the engine journals it. */
export const AdapterEventSchema = v.variant("type", [
  ConnectionLostEventSchema,
  ControlContestedEventSchema,
]);

export type AdapterEvent = v.InferOutput<typeof AdapterEventSchema>;

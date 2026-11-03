import * as v from "valibot";
import { DomEventTypeSchema, DomPayloadSchema } from "./capture.ts";
import { CountSchema, IsoTimestampSchema, NonEmptyStringSchema } from "./common.ts";
import { StorageOperationPayloadSchema } from "./storage.ts";

/** The `Runtime.addBinding` name page instrumentation posts through. */
export const OBSERVER_BINDING = "__recnrunObserver";

/** The version of the hook injected into every document; it changes with the hook's messages. */
export const HOOK_VERSION = 3;

/** Longer binding payloads are dropped unparsed, so a page cannot make the adapter parse megabytes. */
export const MAX_OBSERVER_MESSAGE_LENGTH = 65_536;

/** The CDP target types the adapter instruments; any other type is attached, resumed, and ignored. */
export const INSTRUMENTED_TARGET_TYPES = ["page", "iframe", "worker", "service_worker"] as const;

/**
 * When the adapter's instrumentation reached a target: `before-first-script` for a target Chrome
 * held with `waitForDebuggerOnStart`, `late` for one already running at connect, and `ignored`.
 */
export const INSTALL_MODES = ["before-first-script", "late", "ignored"] as const;

export const InstallModeSchema = v.picklist(INSTALL_MODES);

const DocumentIdSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{32}$/, "A document id is 32 hex digits."),
);

// What the hook fills in itself: its own sequence per document, the time, and its claimed target.
const observerEntries = {
  seq: v.pipe(CountSchema, v.minValue(1)),
  documentId: DocumentIdSchema,
  ts: v.pipe(v.number(), v.minValue(0)),
  targetId: NonEmptyStringSchema,
};

/** The first message of every hooked document. */
export const HookInstalledMessageSchema = v.strictObject({
  kind: v.literal("lifecycle"),
  type: v.literal("document.hook-installed"),
  ...observerEntries,
  payload: v.strictObject({ url: v.string(), hookVersion: v.literal(HOOK_VERSION) }),
});

/** A DOM event the hook observed in the capture phase on its window. */
export const DomMessageSchema = v.strictObject({
  kind: v.literal("dom"),
  type: DomEventTypeSchema,
  ...observerEntries,
  payload: DomPayloadSchema,
});

/** A `localStorage` or `sessionStorage` call the hook observed through its wrapped methods. */
export const StorageMessageSchema = v.strictObject({
  kind: v.literal("storage"),
  type: v.literal("storage.operation"),
  ...observerEntries,
  payload: StorageOperationPayloadSchema,
});

/** A message page instrumentation posts through the observer binding; untrusted until it parses. */
export const ObserverMessageSchema = v.variant("type", [
  HookInstalledMessageSchema,
  DomMessageSchema,
  StorageMessageSchema,
]);

/** An observer message the adapter accepted, with what CDP itself says about where it came from. */
export const InstrumentationEventSchema = v.strictObject({
  type: v.literal("document.hook-installed"),
  // Sequence per source (one attached session); the hook's own per-document sequence is `hookSeq`.
  source: NonEmptyStringSchema,
  seq: v.pipe(CountSchema, v.minValue(1)),
  at: IsoTimestampSchema,
  targetId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  frameId: v.nullable(NonEmptyStringSchema),
  documentId: DocumentIdSchema,
  installMode: v.picklist(["before-first-script", "late"]),
  hookSeq: v.pipe(CountSchema, v.minValue(1)),
  monotonicTimeMs: v.pipe(v.number(), v.minValue(0)),
  url: v.string(),
});

/** One target the instrumentation attached to, with its counters. */
export const InstrumentedTargetSchema = v.strictObject({
  targetId: NonEmptyStringSchema,
  // Chrome can attach one target more than once (a service worker through the browser and its page).
  sessionId: NonEmptyStringSchema,
  type: NonEmptyStringSchema,
  url: v.string(),
  installMode: InstallModeSchema,
  hookInstalled: v.boolean(),
  hookInstalls: CountSchema,
  droppedInvalid: CountSchema,
  droppedUnknownFrame: CountSchema,
  detached: v.boolean(),
  error: v.optional(NonEmptyStringSchema),
});

/** What the instrumentation reached; workers say whether Chrome exposed them as targets at all. */
export const InstrumentationReportSchema = v.strictObject({
  targets: v.array(InstrumentedTargetSchema),
  dedicatedWorkers: v.strictObject({ observed: v.boolean() }),
  serviceWorkers: v.strictObject({ observed: v.boolean() }),
  // Present when raw capture is on: events handed to the sink, and drafts that failed validation.
  capture: v.optional(v.strictObject({ events: CountSchema, dropped: CountSchema })),
});

export type InstallMode = v.InferOutput<typeof InstallModeSchema>;
export type ObserverMessage = v.InferOutput<typeof ObserverMessageSchema>;
export type InstrumentationEvent = v.InferOutput<typeof InstrumentationEventSchema>;
export type InstrumentedTarget = v.InferOutput<typeof InstrumentedTargetSchema>;
export type InstrumentationReport = v.InferOutput<typeof InstrumentationReportSchema>;

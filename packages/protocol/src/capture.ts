import * as v from "valibot";
import { CountSchema, NonEmptyStringSchema } from "./common.ts";
import { EVENT_ENVELOPE_ENTRIES } from "./events.ts";

/** What became of a response body: kept whole, kept in part, lost, or never asked for. */
export const BODY_CONDITIONS = ["captured", "truncated", "unavailable", "not-requested"] as const;

/** The DOM events the hook listens to, in the capture phase on the window. */
export const DOM_EVENT_TYPES = [
  "pointerdown",
  "pointerup",
  "click",
  "dblclick",
  "keydown",
  "keyup",
  "input",
  "change",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "selectionchange",
  "focusin",
  "focusout",
  "scroll",
  "submit",
] as const;

/** The hook clips every string it reports (values, keys, attributes) to this many characters. */
export const MAX_CAPTURED_TEXT = 1024;

/** Response bodies longer than this many characters are kept in part and marked `truncated`. */
export const MAX_INLINE_BODY_LENGTH = 65_536;

const TextSchema = v.pipe(v.string(), v.maxLength(MAX_CAPTURED_TEXT));
const CoordinateSchema = v.pipe(v.number(), v.integer());

export const DomEventTypeSchema = v.picklist(DOM_EVENT_TYPES);
export const BodyConditionSchema = v.picklist(BODY_CONDITIONS);

/** The element an event reached, by the attributes a locator can use later. */
export const DomTargetSchema = v.strictObject({
  tag: NonEmptyStringSchema,
  id: v.optional(TextSchema),
  testId: v.optional(TextSchema),
  name: v.optional(TextSchema),
  role: v.optional(TextSchema),
  inputType: v.optional(TextSchema),
});

export type DomTarget = v.InferOutput<typeof DomTargetSchema>;

/** One DOM event as the hook saw it; password fields report `redacted` instead of keys and values. */
export const DomPayloadSchema = v.strictObject({
  target: DomTargetSchema,
  // Recorded as observed, never used to tell a human from an agent (source plan §6).
  isTrusted: v.boolean(),
  x: v.optional(CoordinateSchema),
  y: v.optional(CoordinateSchema),
  button: v.optional(CoordinateSchema),
  pointerType: v.optional(TextSchema),
  detail: v.optional(CountSchema),
  modifiers: v.optional(v.array(v.picklist(["alt", "ctrl", "meta", "shift"]))),
  key: v.optional(TextSchema),
  code: v.optional(TextSchema),
  repeat: v.optional(v.boolean()),
  inputType: v.optional(TextSchema),
  data: v.optional(v.nullable(TextSchema)),
  isComposing: v.optional(v.boolean()),
  value: v.optional(TextSchema),
  checked: v.optional(v.boolean()),
  redacted: v.optional(v.literal(true)),
  scrollX: v.optional(CoordinateSchema),
  scrollY: v.optional(CoordinateSchema),
  selectionStart: v.optional(CountSchema),
  selectionEnd: v.optional(CountSchema),
  selectedLength: v.optional(CountSchema),
});

const OptionalUrl = v.optional(v.string());
const SourceLocation = {
  url: OptionalUrl,
  line: v.optional(CountSchema),
  column: v.optional(CountSchema),
};

/** A hop of a redirect chain: the URL that answered with a redirect status. */
export const RedirectHopSchema = v.strictObject({
  url: v.string(),
  method: NonEmptyStringSchema,
  status: v.pipe(v.number(), v.integer()),
});

/** A response body with its condition; `reason` says why it is not `captured`. */
export const BodyPayloadSchema = v.strictObject({
  requestId: NonEmptyStringSchema,
  url: v.string(),
  condition: BodyConditionSchema,
  mimeType: v.optional(v.string()),
  // The length of the whole body in characters (base64 characters when `base64Encoded`).
  size: v.optional(CountSchema),
  base64Encoded: v.optional(v.boolean()),
  body: v.optional(v.pipe(v.string(), v.maxLength(MAX_INLINE_BODY_LENGTH))),
  reason: v.optional(NonEmptyStringSchema),
});

const typed = <const C extends string, const T extends string, P extends v.GenericSchema>(
  category: C,
  type: T,
  payload: P,
) =>
  v.strictObject({
    ...EVENT_ENVELOPE_ENTRIES,
    category: v.literal(category),
    type: v.literal(type),
    payload,
  });

const domEvents = v.variant("type", [
  v.strictObject({
    ...EVENT_ENVELOPE_ENTRIES,
    category: v.literal("dom"),
    type: DomEventTypeSchema,
    payload: DomPayloadSchema,
  }),
  typed(
    "dom",
    "dialog-opening",
    v.strictObject({ dialogType: NonEmptyStringSchema, message: v.string(), url: v.string() }),
  ),
  typed(
    "dom",
    "dialog-closed",
    v.strictObject({ result: v.boolean(), userInput: v.optional(v.string()) }),
  ),
]);

const networkEvents = v.variant("type", [
  typed(
    "network",
    "request",
    v.strictObject({
      requestId: NonEmptyStringSchema,
      url: v.string(),
      method: NonEmptyStringSchema,
      resourceType: v.optional(NonEmptyStringSchema),
      redirectChain: v.optional(v.array(RedirectHopSchema)),
    }),
  ),
  typed(
    "network",
    "response",
    v.strictObject({
      requestId: NonEmptyStringSchema,
      url: v.string(),
      status: v.pipe(v.number(), v.integer()),
      statusText: v.string(),
      mimeType: v.string(),
      fromCache: v.optional(v.boolean()),
    }),
  ),
  typed(
    "network",
    "finished",
    v.strictObject({ requestId: NonEmptyStringSchema, encodedDataLength: v.number() }),
  ),
  typed(
    "network",
    "failed",
    v.strictObject({
      requestId: NonEmptyStringSchema,
      errorText: v.string(),
      canceled: v.boolean(),
      blockedReason: v.optional(v.string()),
    }),
  ),
  typed("network", "body", BodyPayloadSchema),
]);

const consoleEvents = v.variant("type", [
  typed(
    "console",
    "api",
    v.strictObject({
      level: NonEmptyStringSchema,
      args: v.array(TextSchema),
      ...SourceLocation,
    }),
  ),
  typed(
    "console",
    "log",
    v.strictObject({
      source: NonEmptyStringSchema,
      level: NonEmptyStringSchema,
      text: v.string(),
      url: OptionalUrl,
      networkRequestId: v.optional(NonEmptyStringSchema),
    }),
  ),
]);

const errorEvents = typed(
  "error",
  "exception",
  v.strictObject({ text: v.string(), description: v.optional(v.string()), ...SourceLocation }),
);

const navigationEvents = v.variant("type", [
  typed(
    "navigation",
    "committed",
    v.strictObject({ url: v.string(), parentFrameId: v.optional(NonEmptyStringSchema) }),
  ),
  typed("navigation", "same-document", v.strictObject({ url: v.string() })),
]);

const targetEvents = v.variant("type", [
  typed(
    "target",
    "attached",
    v.strictObject({
      type: NonEmptyStringSchema,
      url: v.string(),
      installMode: v.picklist(["before-first-script", "late", "ignored"]),
      openerId: v.optional(NonEmptyStringSchema),
    }),
  ),
  typed("target", "detached", v.strictObject({})),
  typed(
    "target",
    "hook-installed",
    v.strictObject({ url: v.string(), hookVersion: v.pipe(v.number(), v.integer()) }),
  ),
]);

/** One raw event the adapter captured, as a journal line: the §11 envelope with a typed payload. */
export const CapturedEventSchema = v.variant("category", [
  domEvents,
  networkEvents,
  consoleEvents,
  errorEvents,
  navigationEvents,
  targetEvents,
]);

export type BodyCondition = v.InferOutput<typeof BodyConditionSchema>;
export type BodyPayload = v.InferOutput<typeof BodyPayloadSchema>;
export type DomEventType = v.InferOutput<typeof DomEventTypeSchema>;
export type DomPayload = v.InferOutput<typeof DomPayloadSchema>;
export type CapturedEvent = v.InferOutput<typeof CapturedEventSchema>;

import * as v from "valibot";
import { CountSchema, NonEmptyStringSchema } from "./common.ts";
import { CapturedTextSchema as TextSchema } from "./captured-text.ts";
import { ConsoleEventSchema, ErrorEventSchema } from "./console.ts";
import {
  EVENT_ENVELOPE_ENTRIES,
  GAP_REASONS,
  GapPayloadSchema,
  typedEvent as typed,
} from "./events.ts";
import { NetworkEventSchema } from "./network.ts";
import { StorageEventSchema } from "./storage.ts";

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

const CoordinateSchema = v.pipe(v.number(), v.integer());

export const DomEventTypeSchema = v.picklist(DOM_EVENT_TYPES);

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
  NetworkEventSchema,
  ConsoleEventSchema,
  ErrorEventSchema,
  StorageEventSchema,
  navigationEvents,
  targetEvents,
  // A loss the collector accounts for, such as messages a full observer buffer dropped.
  v.strictObject({
    ...EVENT_ENVELOPE_ENTRIES,
    category: v.literal("gap"),
    type: v.picklist(GAP_REASONS),
    payload: GapPayloadSchema,
  }),
]);

export type DomEventType = v.InferOutput<typeof DomEventTypeSchema>;
export type DomPayload = v.InferOutput<typeof DomPayloadSchema>;
export type CapturedEvent = v.InferOutput<typeof CapturedEventSchema>;

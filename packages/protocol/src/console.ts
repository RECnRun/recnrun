import * as v from "valibot";
import { CapturedTextSchema as TextSchema } from "./captured-text.ts";
import { CountSchema, NonEmptyStringSchema } from "./common.ts";
import { typedEvent as typed } from "./events.ts";

/** A console call keeps at most this many arguments; later ones are dropped and flagged. */
export const MAX_CONSOLE_ARGS = 32;

/** A preview keeps at most this many properties or entries per object, flagged when cut. */
export const MAX_VALUE_PROPERTIES = 20;

/** A stack keeps at most this many frames, innermost first, flagged when cut. */
export const MAX_STACK_FRAMES = 32;

const KindSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(32));
const Truncated = v.optional(v.literal(true));

const PreviewEntries = {
  type: KindSchema,
  subtype: v.optional(KindSchema),
  description: v.optional(TextSchema),
  truncated: Truncated,
};

const PropertyEntries = {
  name: TextSchema,
  type: KindSchema,
  subtype: v.optional(KindSchema),
  value: v.optional(TextSchema),
};

const limited = <T extends v.GenericSchema>(item: T) =>
  v.pipe(v.array(item), v.maxLength(MAX_VALUE_PROPERTIES));

/** A nested object as Chrome previewed it: its properties as text, nothing deeper. */
export const NestedPreviewSchema = v.strictObject({
  ...PreviewEntries,
  properties: limited(v.strictObject(PropertyEntries)),
});

/**
 * An object as Chrome previewed it at the call. The shape stops at two levels, so depth is bounded
 * by the schema itself; whatever Chrome or the limits left out sets `truncated`.
 */
export const ValuePreviewSchema = v.strictObject({
  ...PreviewEntries,
  properties: limited(
    v.strictObject({ ...PropertyEntries, preview: v.optional(NestedPreviewSchema) }),
  ),
  entries: v.optional(
    limited(v.strictObject({ key: v.optional(NestedPreviewSchema), value: NestedPreviewSchema })),
  ),
});

/** One console argument: a primitive's value, or an object's description and preview. */
export const ConsoleValueSchema = v.strictObject({
  type: KindSchema,
  subtype: v.optional(KindSchema),
  className: v.optional(TextSchema),
  value: v.optional(v.union([TextSchema, v.number(), v.boolean(), v.null()])),
  unserializableValue: v.optional(TextSchema),
  description: v.optional(TextSchema),
  preview: v.optional(ValuePreviewSchema),
  truncated: Truncated,
});

/** One call frame, with lines and columns counted from one. */
export const StackFrameSchema = v.strictObject({
  functionName: TextSchema,
  url: v.string(),
  line: CountSchema,
  column: CountSchema,
});

/** The synchronous stack Chrome recorded, innermost frame first. */
export const StackSchema = v.strictObject({
  frames: v.pipe(v.array(StackFrameSchema), v.maxLength(MAX_STACK_FRAMES)),
  truncated: Truncated,
});

const OptionalUrl = v.optional(v.string());
const SourceLocation = {
  url: OptionalUrl,
  line: v.optional(CountSchema),
  column: v.optional(CountSchema),
};

export const ConsoleEventSchema = v.variant("type", [
  typed(
    "console",
    "api",
    v.strictObject({
      level: NonEmptyStringSchema,
      args: v.pipe(v.array(TextSchema), v.maxLength(MAX_CONSOLE_ARGS)),
      values: v.optional(v.pipe(v.array(ConsoleValueSchema), v.maxLength(MAX_CONSOLE_ARGS))),
      stack: v.optional(StackSchema),
      truncated: Truncated,
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
      stack: v.optional(StackSchema),
    }),
  ),
]);

export const ErrorEventSchema = typed(
  "error",
  "exception",
  v.strictObject({
    text: v.string(),
    // Unbounded in journals written before F3.2; the adapter clips it and sets `truncated`.
    description: v.optional(v.string()),
    stack: v.optional(StackSchema),
    truncated: Truncated,
    ...SourceLocation,
  }),
);

export type ConsoleValue = v.InferOutput<typeof ConsoleValueSchema>;
export type ValuePreview = v.InferOutput<typeof ValuePreviewSchema>;
export type NestedPreview = v.InferOutput<typeof NestedPreviewSchema>;
export type Stack = v.InferOutput<typeof StackSchema>;

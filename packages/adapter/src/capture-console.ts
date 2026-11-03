import {
  MAX_CAPTURED_TEXT,
  MAX_CONSOLE_ARGS,
  MAX_STACK_FRAMES,
  MAX_VALUE_PROPERTIES,
  type ConsoleValue,
  type NestedPreview,
  type Stack,
  type ValuePreview,
} from "@recnrun/protocol";
import * as v from "valibot";
import type { Draft, Mapped } from "./capture-envelope.ts";

const PropertyPreviewSchema = v.object({
  name: v.string(),
  type: v.string(),
  subtype: v.optional(v.string()),
  value: v.optional(v.string()),
  valuePreview: v.optional(v.unknown()),
});

// Nested previews stay `unknown` here and are parsed only at the levels the journal keeps.
const ObjectPreviewSchema = v.object({
  type: v.string(),
  subtype: v.optional(v.string()),
  description: v.optional(v.string()),
  overflow: v.boolean(),
  properties: v.array(PropertyPreviewSchema),
  entries: v.optional(v.array(v.object({ key: v.optional(v.unknown()), value: v.unknown() }))),
});

const RemoteObjectSchema = v.object({
  type: v.string(),
  subtype: v.optional(v.string()),
  className: v.optional(v.string()),
  value: v.optional(v.unknown()),
  unserializableValue: v.optional(v.string()),
  description: v.optional(v.string()),
  preview: v.optional(v.unknown()),
});

const StackTraceSchema = v.object({
  callFrames: v.array(
    v.object({
      functionName: v.optional(v.string(), ""),
      url: v.string(),
      lineNumber: v.number(),
      columnNumber: v.number(),
    }),
  ),
});

const ConsoleSchema = v.object({
  type: v.string(),
  args: v.array(RemoteObjectSchema),
  executionContextId: v.number(),
  stackTrace: v.optional(StackTraceSchema),
});

const ExceptionSchema = v.object({
  exceptionDetails: v.object({
    text: v.string(),
    url: v.optional(v.string()),
    lineNumber: v.number(),
    columnNumber: v.number(),
    executionContextId: v.optional(v.number()),
    exception: v.optional(RemoteObjectSchema),
    stackTrace: v.optional(StackTraceSchema),
  }),
});

const LogSchema = v.object({
  entry: v.object({
    source: v.pipe(v.string(), v.nonEmpty()),
    level: v.pipe(v.string(), v.nonEmpty()),
    text: v.string(),
    url: v.optional(v.string()),
    networkRequestId: v.optional(v.string()),
    stackTrace: v.optional(StackTraceSchema),
  }),
});

type RemoteObject = v.InferOutput<typeof RemoteObjectSchema>;
type PropertyPreview = v.InferOutput<typeof PropertyPreviewSchema>;

/** Records whether anything was clipped or dropped, and passes that on to the enclosing part. */
class Cut {
  any = false;

  text(value: string): string {
    if (value.length > MAX_CAPTURED_TEXT) this.any = true;
    return value.slice(0, MAX_CAPTURED_TEXT);
  }

  list<T>(items: readonly T[], max: number): T[] {
    if (items.length > max) this.any = true;
    return items.slice(0, max);
  }

  flag(parent?: Cut): { truncated?: true } {
    if (this.any && parent) parent.any = true;
    return this.any ? { truncated: true } : {};
  }
}

function previewHead(raw: v.InferOutput<typeof ObjectPreviewSchema>, cut: Cut) {
  if (raw.overflow) cut.any = true;
  return {
    type: raw.type,
    ...(raw.subtype && { subtype: raw.subtype }),
    ...(raw.description !== undefined && { description: cut.text(raw.description) }),
  };
}

function propertyOf(raw: PropertyPreview, cut: Cut) {
  return {
    name: cut.text(raw.name),
    type: raw.type,
    ...(raw.subtype && { subtype: raw.subtype }),
    ...(raw.value !== undefined && { value: cut.text(raw.value) }),
  };
}

/** A preview below the argument's own: properties as text, anything deeper dropped. */
function nestedPreview(raw: unknown, parent: Cut): NestedPreview | undefined {
  const parsed = v.safeParse(ObjectPreviewSchema, raw);
  if (!parsed.success) return undefined;
  const cut = new Cut();
  const { properties, entries = [] } = parsed.output;
  if (entries.length > 0 || properties.some((p) => p.valuePreview !== undefined)) cut.any = true;
  const head = previewHead(parsed.output, cut);
  const kept = cut.list(properties, MAX_VALUE_PROPERTIES).map((p) => propertyOf(p, cut));
  return { ...head, properties: kept, ...cut.flag(parent) };
}

function entryOf(raw: { key?: unknown; value: unknown }, cut: Cut) {
  const key = raw.key === undefined ? undefined : nestedPreview(raw.key, cut);
  const value = nestedPreview(raw.value, cut);
  return value && { ...(key && { key }), value };
}

function valuePreview(raw: unknown, parent: Cut): ValuePreview | undefined {
  const parsed = v.safeParse(ObjectPreviewSchema, raw);
  if (!parsed.success) return undefined;
  const cut = new Cut();
  const head = previewHead(parsed.output, cut);
  const properties = cut.list(parsed.output.properties, MAX_VALUE_PROPERTIES).map((p) => {
    const preview = p.valuePreview === undefined ? undefined : nestedPreview(p.valuePreview, cut);
    return { ...propertyOf(p, cut), ...(preview && { preview }) };
  });
  const rawEntries = parsed.output.entries;
  const entries =
    rawEntries && cut.list(rawEntries, MAX_VALUE_PROPERTIES).flatMap((e) => entryOf(e, cut) ?? []);
  return { ...head, properties, ...(entries && { entries }), ...cut.flag(parent) };
}

function primitive(value: unknown, cut: Cut): ConsoleValue["value"] {
  if (typeof value === "string") return cut.text(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

/** One console argument as Chrome described it at the call, within the journal's limits. */
function consoleValue(object: RemoteObject, parent: Cut): ConsoleValue {
  const cut = new Cut();
  const value = primitive(object.value, cut);
  const preview = object.preview === undefined ? undefined : valuePreview(object.preview, parent);
  const { subtype, className, unserializableValue, description } = object;
  return {
    type: object.type,
    ...(subtype && { subtype }),
    ...(className !== undefined && { className: cut.text(className) }),
    ...(value !== undefined && { value }),
    ...(unserializableValue !== undefined && {
      unserializableValue: cut.text(unserializableValue),
    }),
    ...(description !== undefined && { description: cut.text(description) }),
    ...(preview && { preview }),
    ...cut.flag(parent),
  };
}

/** The text of an argument, as the `args` list has kept it since F1.5. */
function textOf(object: RemoteObject): string {
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === "string" && typeof object.value === "string") return object.value;
  if (object.value !== undefined) return JSON.stringify(object.value) ?? object.type;
  return object.description ?? object.type;
}

// CDP lines and columns count from zero; the journal counts them from one, as editors do.
const location = (url: string | undefined, line: number, column: number) => ({
  ...(url && { url }),
  line: line + 1,
  column: column + 1,
});

function stackOf(trace: v.InferOutput<typeof StackTraceSchema> | undefined): Stack | undefined {
  if (!trace || trace.callFrames.length === 0) return undefined;
  const cut = new Cut();
  const frames = cut.list(trace.callFrames, MAX_STACK_FRAMES).map((frame) => ({
    functionName: cut.text(frame.functionName),
    ...location(frame.url, frame.lineNumber, frame.columnNumber),
    url: frame.url,
  }));
  return { frames, ...cut.flag() };
}

export function consoleCall(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(ConsoleSchema, params);
  if (!parsed.success) return undefined;
  const { type, args, executionContextId, stackTrace } = parsed.output;
  const cut = new Cut();
  const kept = cut.list(args, MAX_CONSOLE_ARGS);
  const stack = stackOf(stackTrace);
  const top = stackTrace?.callFrames[0];
  const payload = {
    level: type,
    args: kept.map((arg) => cut.text(textOf(arg))),
    values: kept.map((arg) => consoleValue(arg, cut)),
    ...(stack && { stack }),
    ...cut.flag(),
    ...(top && location(top.url, top.lineNumber, top.columnNumber)),
  };
  const draft: Draft = { category: "console", type: "api", component: "application", payload };
  return { draft, contextId: executionContextId };
}

export function exception(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(ExceptionSchema, params);
  if (!parsed.success) return undefined;
  const { text, url, lineNumber, columnNumber, executionContextId, exception, stackTrace } =
    parsed.output.exceptionDetails;
  const cut = new Cut();
  const description = exception && cut.text(textOf(exception));
  const stack = stackOf(stackTrace);
  const payload = {
    text,
    ...(description !== undefined && { description }),
    ...(stack && { stack }),
    ...cut.flag(),
    ...location(url, lineNumber, columnNumber),
  };
  const draft: Draft = { category: "error", type: "exception", component: "application", payload };
  return { draft, ...(executionContextId !== undefined && { contextId: executionContextId }) };
}

export function logEntry(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(LogSchema, params);
  if (!parsed.success) return undefined;
  const { networkRequestId, url, stackTrace, ...entry } = parsed.output.entry;
  const stack = stackOf(stackTrace);
  const payload = {
    ...entry,
    ...(url && { url }),
    ...(networkRequestId && { networkRequestId }),
    ...(stack && { stack }),
  };
  return { draft: { category: "console", type: "log", component: "browser", payload } };
}

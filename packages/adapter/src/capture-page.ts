import { MAX_CAPTURED_TEXT } from "@recnrun/protocol";
import * as v from "valibot";
import type { Draft } from "./capture-envelope.ts";

/** A mapped CDP event and the context CDP named for it: an execution context or a frame. */
export interface Mapped {
  draft: Draft;
  contextId?: number;
  frameId?: string;
}

const MAX_ARGS = 32;

const RemoteObjectSchema = v.object({
  type: v.string(),
  value: v.optional(v.unknown()),
  unserializableValue: v.optional(v.string()),
  description: v.optional(v.string()),
});

const StackTraceSchema = v.object({
  callFrames: v.array(
    v.object({ url: v.string(), lineNumber: v.number(), columnNumber: v.number() }),
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
  }),
});

const LogSchema = v.object({
  entry: v.object({
    source: v.pipe(v.string(), v.nonEmpty()),
    level: v.pipe(v.string(), v.nonEmpty()),
    text: v.string(),
    url: v.optional(v.string()),
    networkRequestId: v.optional(v.string()),
  }),
});

const FrameNavigatedSchema = v.object({
  frame: v.object({ id: v.string(), url: v.string(), parentId: v.optional(v.string()) }),
});

const SameDocumentSchema = v.object({ frameId: v.string(), url: v.string() });

const DialogOpeningSchema = v.object({
  url: v.string(),
  message: v.string(),
  type: v.string(),
  frameId: v.optional(v.string()),
});

const DialogClosedSchema = v.object({
  result: v.boolean(),
  userInput: v.optional(v.string()),
  frameId: v.optional(v.string()),
});

const clip = (text: string) => text.slice(0, MAX_CAPTURED_TEXT);

function preview(object: v.InferOutput<typeof RemoteObjectSchema>): string {
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

function consoleCall(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(ConsoleSchema, params);
  if (!parsed.success) return undefined;
  const { type, args, executionContextId, stackTrace } = parsed.output;
  const top = stackTrace?.callFrames[0];
  const payload = {
    level: type,
    args: args.slice(0, MAX_ARGS).map((arg) => clip(preview(arg))),
    ...(top && location(top.url, top.lineNumber, top.columnNumber)),
  };
  const draft: Draft = { category: "console", type: "api", component: "application", payload };
  return { draft, contextId: executionContextId };
}

function exception(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(ExceptionSchema, params);
  if (!parsed.success) return undefined;
  const { text, url, lineNumber, columnNumber, executionContextId, exception } =
    parsed.output.exceptionDetails;
  const description = exception && preview(exception);
  const payload = {
    text,
    ...(description !== undefined && { description }),
    ...location(url, lineNumber, columnNumber),
  };
  const draft: Draft = { category: "error", type: "exception", component: "application", payload };
  return { draft, ...(executionContextId !== undefined && { contextId: executionContextId }) };
}

function logEntry(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(LogSchema, params);
  if (!parsed.success) return undefined;
  const { networkRequestId, url, ...entry } = parsed.output.entry;
  const payload = { ...entry, ...(url && { url }), ...(networkRequestId && { networkRequestId }) };
  return { draft: { category: "console", type: "log", component: "browser", payload } };
}

function navigated(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(FrameNavigatedSchema, params);
  if (!parsed.success) return undefined;
  const { id, url, parentId } = parsed.output.frame;
  const payload = { url, ...(parentId && { parentFrameId: parentId }) };
  return {
    draft: { category: "navigation", type: "committed", component: "browser", payload },
    frameId: id,
  };
}

function sameDocument(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(SameDocumentSchema, params);
  if (!parsed.success) return undefined;
  const { frameId, url } = parsed.output;
  const payload = { url };
  return {
    draft: { category: "navigation", type: "same-document", component: "browser", payload },
    frameId,
  };
}

function dialogOpening(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(DialogOpeningSchema, params);
  if (!parsed.success) return undefined;
  const { url, message, type, frameId } = parsed.output;
  const payload = { dialogType: type, message: clip(message), url };
  const draft: Draft = { category: "dom", type: "dialog-opening", component: "browser", payload };
  return { draft, ...(frameId && { frameId }) };
}

function dialogClosed(params: unknown): Mapped | undefined {
  const parsed = v.safeParse(DialogClosedSchema, params);
  if (!parsed.success) return undefined;
  const { result, userInput, frameId } = parsed.output;
  const payload = { result, ...(userInput !== undefined && { userInput: clip(userInput) }) };
  const draft: Draft = { category: "dom", type: "dialog-closed", component: "browser", payload };
  return { draft, ...(frameId && { frameId }) };
}

const MAPPINGS: Readonly<Record<string, (params: unknown) => Mapped | undefined>> = {
  "Runtime.consoleAPICalled": consoleCall,
  "Runtime.exceptionThrown": exception,
  "Log.entryAdded": logEntry,
  "Page.frameNavigated": navigated,
  "Page.navigatedWithinDocument": sameDocument,
  "Page.javascriptDialogOpening": dialogOpening,
  "Page.javascriptDialogClosed": dialogClosed,
};

/** Maps a page session's console, error, log, navigation, or dialog event; others are not ours. */
export function mapPageEvent(method: string, params: unknown): Mapped | undefined {
  return MAPPINGS[method]?.(params);
}

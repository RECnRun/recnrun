import { MAX_CAPTURED_TEXT } from "@recnrun/protocol";
import * as v from "valibot";
import { consoleCall, exception, logEntry } from "./capture-console.ts";
import type { Draft, Mapped } from "./capture-envelope.ts";

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

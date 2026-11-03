import * as v from "valibot";
import { messageOf } from "@/background/probes/helpers";
import { isLoopbackUrl, REFUSED } from "@/background/probes/loopback";
import type { Debuggee, DebuggerApi } from "@/background/probes/types";
import { command } from "@/background/route-a/attached";
import type { ArmRequest } from "@/background/route-b/requests";
import {
  fetchedSelection,
  isFetchedSelection,
  selectionWrapper,
} from "@/background/route-b/select";
import type { PausedEntry } from "@/background/route-b/types";
import {
  byteLength,
  decodeBase64,
  encodeBase64,
  fulfilledHeaders,
  wrapScript,
} from "@/background/route-b/wrap";

// Chrome's Fetch.requestPaused parameters, as far as Route B reads them.
const PausedEventSchema = v.object({
  requestId: v.string(),
  request: v.object({ url: v.string(), headers: v.record(v.string(), v.string()) }),
  resourceType: v.string(),
  responseStatusCode: v.optional(v.number()),
  responseStatusText: v.optional(v.string()),
  responseHeaders: v.optional(v.array(v.object({ name: v.string(), value: v.string() }))),
  responseErrorReason: v.optional(v.string()),
});

export type PausedEvent = v.InferOutput<typeof PausedEventSchema>;

const JAVASCRIPT = /\b(java|ecma)script\b/i;
// Chrome reports a worker's own fetch() as XHR and a page's as Fetch: data it reads, not code it runs.
const DATA_TYPES = new Set(["Fetch", "XHR"]);

export interface PausedContext {
  api: DebuggerApi;
  request: ArmRequest;
  moduleUrl: string;
  /** `chrome-extension://<id>/`, where E6's selection wrappers import from. */
  extensionOrigin: string;
  now: () => number;
}

export function pausedEventOf(params: unknown): PausedEvent | undefined {
  const result = v.safeParse(PausedEventSchema, params);
  return result.success ? result.output : undefined;
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

export function pausedEntryOf(source: Debuggee, event: PausedEvent, pausedAt: number): PausedEntry {
  const response =
    event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
  return {
    session: source.sessionId === undefined ? "tab" : "worker",
    ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
    url: event.request.url,
    resourceType: event.resourceType,
    stage: response ? "response" : "request",
    ...(event.responseStatusCode === undefined ? {} : { status: event.responseStatusCode }),
    ...(event.responseErrorReason === undefined ? {} : { errorReason: event.responseErrorReason }),
    action: "continued",
    pausedAt,
  };
}

/** Whether the paused response is a script the worker runs: 2xx, JavaScript, and not a fetch(). */
function isScript(event: PausedEvent): boolean {
  const status = event.responseStatusCode ?? 0;
  if (event.responseErrorReason !== undefined || status < 200 || status >= 300) return false;
  const headers = Object.fromEntries((event.responseHeaders ?? []).map((h) => [h.name, h.value]));
  return (
    JAVASCRIPT.test(headerOf(headers, "content-type") ?? "") && !DATA_TYPES.has(event.resourceType)
  );
}

/** Main scripts always; imported scripts on a worker's session when asked; worker scripts for sync-xhr. */
function shouldTransform(entry: PausedEntry, request: ArmRequest): boolean {
  if (entry.role === "main") return true;
  if (entry.role !== "imported") return false;
  // A dedicated or shared worker's own script carries no Service-Worker header.
  if (request.selection === "sync-xhr") return isWorkerScript(entry);
  return entry.session === "worker" && request.imports === "transform";
}

/** Chrome fetches a dedicated or shared worker's script for the page, as type Other, not Script. */
function isWorkerScript(entry: PausedEntry): boolean {
  return entry.session === "worker" || entry.resourceType === "Other";
}

function wrapperOf(context: PausedContext, original: string) {
  const { request, moduleUrl, extensionOrigin } = context;
  if (request.selection === undefined) return wrapScript(request.marker, original, moduleUrl);
  const body = selectionWrapper(request.selection, original, extensionOrigin);
  return { body, wrapper: request.selection };
}

async function fulfill(
  context: PausedContext,
  target: Debuggee,
  entry: PausedEntry,
  event: PausedEvent,
): Promise<void> {
  const { api, now } = context;
  const { requestId } = event;
  const reply = await command(api, target, "Fetch.getResponseBody", { requestId });
  const text = typeof reply.body === "string" ? reply.body : "";
  const original = reply.base64Encoded === true ? decodeBase64(text) : text;
  const wrapped = wrapperOf(context, original);
  await command(api, target, "Fetch.fulfillRequest", {
    requestId,
    responseCode: event.responseStatusCode,
    ...(event.responseStatusText ? { responsePhrase: event.responseStatusText } : {}),
    responseHeaders: fulfilledHeaders(event.responseHeaders ?? []),
    body: encodeBase64(wrapped.body),
  });
  Object.assign(entry, {
    action: "fulfilled",
    declared: "transformed",
    wrapper: wrapped.wrapper,
    originalBytes: byteLength(original),
    fulfilledBytes: byteLength(wrapped.body),
    waitedMs: now() - entry.pausedAt,
  });
}

/** Answers the selection path, whatever the origin answered, with the bootstrap of the armed marker. */
async function fulfillSelection(
  context: PausedContext,
  target: Debuggee,
  entry: PausedEntry,
  event: PausedEvent,
): Promise<void> {
  const body = fetchedSelection(context.request.marker);
  await command(context.api, target, "Fetch.fulfillRequest", {
    requestId: event.requestId,
    responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript" }],
    body: encodeBase64(body),
  });
  Object.assign(entry, {
    action: "fulfilled",
    fulfilledBytes: byteLength(body),
    waitedMs: context.now() - entry.pausedAt,
  });
}

function isSelectionPath(context: PausedContext, entry: PausedEntry, event: PausedEvent): boolean {
  if (context.request.selection !== "fetch-import" || entry.stage !== "response") return false;
  return isFetchedSelection(event.request.url);
}

async function letGo(context: PausedContext, target: Debuggee, entry: PausedEntry, id: string) {
  try {
    await command(context.api, target, "Fetch.continueRequest", { requestId: id });
    entry.action = "continued";
    entry.waitedMs = context.now() - entry.pausedAt;
  } catch (error) {
    entry.action = "failed";
    entry.error ??= messageOf(error);
  }
}

/** Wraps a script Route B should transform and lets every other paused request go unchanged. */
export async function handlePaused(
  context: PausedContext,
  target: Debuggee,
  entry: PausedEntry,
  event: PausedEvent,
): Promise<void> {
  // R11: a request of a site the armed tab navigated to goes on unread.
  if (!isLoopbackUrl(event.request.url)) {
    entry.refused = REFUSED;
    return letGo(context, target, entry, event.requestId);
  }
  if (isSelectionPath(context, entry, event)) entry.role = "selection";
  else if (entry.stage === "response" && isScript(event)) {
    const main = headerOf(event.request.headers, "service-worker") === "script";
    entry.role = main ? "main" : "imported";
  }
  const selection = entry.role === "selection";
  if (selection || shouldTransform(entry, context.request)) {
    try {
      await (selection ? fulfillSelection : fulfill)(context, target, entry, event);
      return;
    } catch (error) {
      entry.error = messageOf(error);
    }
  }
  await letGo(context, target, entry, event.requestId);
}

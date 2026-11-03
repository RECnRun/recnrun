import type { BodyPayload } from "@recnrun/protocol";
import * as v from "valibot";
import type { Draft } from "./capture-envelope.ts";
import {
  BodySchema,
  FailedSchema,
  FinishedSchema,
  network,
  RequestIdSchema,
  RequestSchema,
  ResponseSchema,
} from "./capture-network-cdp.ts";
import {
  bodyBytes,
  cacheOf,
  headerEntries,
  timingOf,
  type BodySink,
} from "./capture-network-evidence.ts";
import { webSocketDraft } from "./capture-websocket.ts";

/** What one session's network capture needs from the capture around it. */
export interface NetworkSession {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  emit(draft: Draft, frameId: string | null): void;
  /** Registers work that `settled()` waits for. */
  track(work: Promise<void>): void;
  bodyTimeoutMs: number;
  maxBodyLength: number;
  /** Lowercase names of the headers recorded as `redacted`. */
  sensitive: ReadonlySet<string>;
  /** Where bodies are stored; without one they are kept inline, capped at `maxBodyLength`. */
  blobs?: BodySink;
}

type Hop = { url: string; method: string; status: number };

interface Request {
  requestId: string;
  url: string;
  method: string;
  frameId: string | null;
  resourceType?: string;
  chain: Hop[];
  mimeType?: string;
  // Chrome reports a memory cache hit before the response, which carries no flag for it.
  fromMemory?: boolean;
  // `open` until the body is settled one way or another; a body is recorded at most once.
  body: "none" | "open" | "reading" | "done";
  timer?: ReturnType<typeof setTimeout>;
  // Ends a body read that settled another way, so `settled()` never waits for a late reply.
  abandon?: () => void;
}

// Bodies the page itself asked for; images, scripts, styles, and fonts are not requested.
const BODY_TYPES = new Set(["Document", "XHR", "Fetch"]);

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Network events of one session, with each response body read once it finished loading. */
export class NetworkCapture {
  private readonly requests = new Map<string, Request>();
  private readonly session: NetworkSession;

  constructor(session: NetworkSession) {
    this.session = session;
  }

  handle(method: string, params: unknown): void {
    if (method === "Network.requestWillBeSent") this.request(params);
    else if (method === "Network.responseReceived") this.response(params);
    else if (method === "Network.loadingFinished") this.finished(params);
    else if (method === "Network.loadingFailed") this.failed(params);
    else if (method === "Network.requestServedFromCache") this.servedFromCache(params);
    else {
      const draft = webSocketDraft(method, params, this.session.sensitive);
      if (draft) this.session.emit(draft, null);
    }
  }

  /** Settles every body still open, as when the capture stops or the target goes away. */
  close(why: string): void {
    for (const request of this.requests.values()) {
      if (request.body === "open" || request.body === "reading")
        this.settle(request, this.unread(request, why));
    }
    this.requests.clear();
  }

  private request(params: unknown): void {
    const parsed = v.safeParse(RequestSchema, params);
    if (!parsed.success) return;
    const { requestId, request, type, frameId, redirectResponse } = parsed.output;
    const previous = this.requests.get(requestId);
    // CDP keeps the request id across redirects and reports each hop on the next request.
    const chain = previous && redirectResponse ? previous.chain : [];
    if (previous && redirectResponse)
      chain.push({
        url: redirectResponse.url,
        method: previous.method,
        status: redirectResponse.status,
      });
    const entry: Request = {
      requestId,
      url: request.url,
      method: request.method,
      frameId: frameId ?? null,
      chain,
      body: "none",
    };
    if (type) entry.resourceType = type;
    this.requests.set(requestId, entry);
    const payload = {
      requestId,
      url: request.url,
      method: request.method,
      ...(type && { resourceType: type }),
      ...(chain.length > 0 && { redirectChain: [...chain] }),
      ...headerEntries(request.headers, this.session.sensitive),
    };
    this.session.emit(network("request", payload), entry.frameId);
  }

  private servedFromCache(params: unknown): void {
    const parsed = v.safeParse(RequestIdSchema, params);
    const entry = parsed.success ? this.requests.get(parsed.output.requestId) : undefined;
    if (entry) entry.fromMemory = true;
  }

  private response(params: unknown): void {
    const parsed = v.safeParse(ResponseSchema, params);
    if (!parsed.success) return;
    const { requestId, type, frameId, response } = parsed.output;
    const entry: Request = this.requests.get(requestId) ?? {
      requestId,
      url: response.url,
      method: "GET",
      frameId: frameId ?? null,
      chain: [],
      body: "none",
    };
    if (type) entry.resourceType = type;
    entry.mimeType = response.mimeType;
    entry.body = "open";
    this.requests.set(requestId, entry);
    const { url, status, statusText, mimeType, headers } = response;
    const cache = cacheOf(response, entry.fromMemory === true);
    const timing = timingOf(response.timing);
    const payload = {
      requestId,
      url,
      status,
      statusText,
      mimeType,
      cache,
      ...(cache !== "network" && { fromCache: true }),
      ...(timing && { timing }),
      ...headerEntries(headers, this.session.sensitive),
    };
    this.session.emit(network("response", payload), entry.frameId);
    const ms = this.session.bodyTimeoutMs;
    entry.timer = setTimeout(() => {
      if (entry.body !== "open" || !this.wanted(entry)) return;
      this.settle(entry, {
        condition: "unavailable",
        reason: `The response was still loading after ${ms} ms.`,
      });
    }, ms);
  }

  private finished(params: unknown): void {
    const parsed = v.safeParse(FinishedSchema, params);
    if (!parsed.success) return;
    const { requestId, encodedDataLength } = parsed.output;
    const entry = this.requests.get(requestId);
    this.session.emit(
      network("finished", { requestId, encodedDataLength }),
      entry?.frameId ?? null,
    );
    if (entry?.body === "open" && this.wanted(entry)) {
      this.read(requestId, entry);
      return;
    }
    if (entry?.body === "open") this.settle(entry, this.unread(entry, ""));
    this.forget(requestId, entry);
  }

  private failed(params: unknown): void {
    const parsed = v.safeParse(FailedSchema, params);
    if (!parsed.success) return;
    const { requestId, errorText, canceled = false, blockedReason } = parsed.output;
    const entry = this.requests.get(requestId);
    const payload = { requestId, errorText, canceled, ...(blockedReason && { blockedReason }) };
    this.session.emit(network("failed", payload), entry?.frameId ?? null);
    if (entry?.body === "open" || entry?.body === "reading")
      this.settle(entry, { condition: "unavailable", reason: `Loading failed: ${errorText}` });
    this.forget(requestId, entry);
  }

  private read(requestId: string, entry: Request): void {
    entry.body = "reading";
    const ms = this.session.bodyTimeoutMs;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.body !== "reading") return;
      this.settle(entry, {
        condition: "unavailable",
        reason: `Chrome did not return the body within ${ms} ms.`,
      });
    }, ms);
    const abandoned = new Promise<void>((resolve) => {
      entry.abandon = resolve;
    });
    const reply = this.session
      .send("Network.getResponseBody", { requestId })
      .then(
        (result) => this.bodyFrom(result, entry),
        (error: unknown) => ({ condition: "unavailable" as const, reason: reason(error) }),
      )
      .then((body) => {
        if (entry.body === "reading") this.settle(entry, body);
      });
    const work = Promise.race([reply, abandoned]).then(() => this.forget(requestId, entry));
    this.session.track(work);
  }

  private async bodyFrom(result: unknown, entry: Request): Promise<Partial<BodyPayload>> {
    const parsed = v.safeParse(BodySchema, result);
    if (!parsed.success)
      return { condition: "unavailable", reason: "Chrome answered without a body." };
    const { body, base64Encoded } = parsed.output;
    const { blobs } = this.session;
    if (blobs && entry.body === "reading") return this.store(blobs, entry, body, base64Encoded);
    const max = this.session.maxBodyLength;
    const condition = body.length > max ? "truncated" : "captured";
    return { condition, size: body.length, base64Encoded, body: body.slice(0, max) };
  }

  private async store(
    blobs: BodySink,
    entry: Request,
    body: string,
    base64Encoded: boolean,
  ): Promise<Partial<BodyPayload>> {
    // Chrome answered; the read deadline no longer applies to writing the blob.
    clearTimeout(entry.timer);
    const { content, encoding } = bodyBytes(body, base64Encoded);
    try {
      const blob = await blobs.put(content, { mime: entry.mimeType ?? "", encoding });
      return { condition: blob.condition, blob };
    } catch (error) {
      return { condition: "unavailable", reason: `The body could not be stored: ${reason(error)}` };
    }
  }

  private wanted(entry: Request): boolean {
    return entry.resourceType !== undefined && BODY_TYPES.has(entry.resourceType);
  }

  private unread(entry: Request, why: string): Partial<BodyPayload> {
    if (this.wanted(entry)) return { condition: "unavailable", reason: why };
    return {
      condition: "not-requested",
      reason: `Bodies of ${entry.resourceType ?? "unknown"} resources are not requested.`,
    };
  }

  private settle(entry: Request, body: Partial<BodyPayload>): void {
    entry.body = "done";
    clearTimeout(entry.timer);
    entry.abandon?.();
    const payload = {
      requestId: entry.requestId,
      url: entry.url,
      ...(entry.mimeType && { mimeType: entry.mimeType }),
      ...body,
    };
    this.session.emit(network("body", payload), entry.frameId);
  }

  private forget(requestId: string, entry: Request | undefined): void {
    clearTimeout(entry?.timer);
    // A later hop or a new request may already use this id; only the same entry is removed.
    if (this.requests.get(requestId) === entry) this.requests.delete(requestId);
  }
}

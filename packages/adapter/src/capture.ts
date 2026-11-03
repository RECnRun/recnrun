import {
  MAX_INLINE_BODY_LENGTH,
  type CapturedEvent,
  type ObserverMessage,
} from "@recnrun/protocol";
import type { CdpChannel, CdpEvent } from "./cdp-socket.ts";
import {
  ContextDocuments,
  documentRead,
  READ_HOOK_DOCUMENT,
  withDeadline,
} from "./capture-documents.ts";
import type { StorageSession } from "./capture-cookies.ts";
import { createEmitter, type Draft, type Emitter, type Origin } from "./capture-envelope.ts";
import { NetworkCapture } from "./capture-network.ts";
import { sensitiveHeaders, type BodySink } from "./capture-network-evidence.ts";
import { mapPageEvent } from "./capture-page.ts";
import { StorageCapture } from "./capture-storage.ts";
import type { TargetRecord } from "./instrumentation-targets.ts";

/** Raw capture: every event becomes a validated journal line handed to `onEvent`. */
export interface CaptureOptions {
  /** The run the journal belongs to; every event carries it. */
  runId: string;
  onEvent: (event: CapturedEvent) => void;
  /** How long a response may keep loading before its body is recorded as unavailable. */
  bodyTimeoutMs?: number;
  /** Bodies longer than this many characters are kept in part and marked truncated; at most `MAX_INLINE_BODY_LENGTH`. */
  maxBodyLength?: number;
  /** Stores response bodies by digest; without it bodies stay inline in the journal. */
  blobs?: BodySink;
  /** Header names recorded as `redacted` besides `SENSITIVE_HEADERS`, matched without case. */
  redactHeaders?: readonly string[];
  /** How often a page's cookie jar is read for changes, in milliseconds; 0 reads it only after a response that sets cookies and on navigation. */
  cookiePollMs?: number;
}

const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_COOKIE_POLL_MS = 1_000;
// How long events of a navigated context wait for its hook to name the new document.
const DOCUMENT_READ_TIMEOUT_MS = 2_000;
const BROWSER: Origin = {
  producer: "cdp:browser",
  source: "browser",
  targetId: null,
  frameId: null,
  documentId: null,
};

/** Turns what the instrumentation sees into captured events, numbered per CDP session. */
export class Capture {
  private readonly emitter: Emitter;
  private readonly networks = new Map<string, NetworkCapture>();
  private readonly storages = new Map<string, StorageCapture>();
  private readonly documents = new ContextDocuments();
  private readonly channel: CdpChannel;
  private readonly options: CaptureOptions;
  private readonly track: (work: Promise<void>) => void;

  constructor(
    channel: CdpChannel,
    options: CaptureOptions & { now: () => Date },
    track: (work: Promise<void>) => void,
  ) {
    this.channel = channel;
    this.options = options;
    this.track = track;
    this.emitter = createEmitter(options);
  }

  counts(): { events: number; dropped: number } {
    return this.emitter.counts();
  }

  attached({ info }: TargetRecord, openerId: string | undefined): void {
    const { targetId, type, url, installMode } = info;
    const payload = { type, url, installMode, ...(openerId && { openerId }) };
    this.emitter.emit(
      { ...BROWSER, targetId },
      { category: "target", type: "attached", component: "browser", payload },
    );
  }

  /** The target's instrumentation was sent; a target that was already running reads its storage. */
  started(record: TargetRecord): void {
    const storage = this.storage(record);
    if (record.info.installMode === "late") storage?.started(record.info.url);
  }

  detached(record: TargetRecord): void {
    this.storages.get(record.sessionId)?.close();
    this.storages.delete(record.sessionId);
    this.networks
      .get(record.sessionId)
      ?.close("The target went away before the response finished loading.");
    this.networks.delete(record.sessionId);
    this.documents.releaseAll(`${record.sessionId}:`);
    this.emitter.emit(
      { ...BROWSER, targetId: record.info.targetId },
      { category: "target", type: "detached", component: "browser", payload: {} },
    );
  }

  /** An accepted hook message, from the frame and context CDP delivered it through. */
  observed(
    record: TargetRecord,
    message: ObserverMessage,
    frameId: string | null,
    contextId: number,
  ): void {
    const key = `${record.sessionId}:${contextId}`;
    this.documents.set(key, message.documentId);
    const origin = { ...this.origin(record, frameId), documentId: message.documentId };
    this.emitter.emit(origin, { ...observedDraft(message), monotonicTimeMs: message.ts });
    // An install starts a document in this context; what waited for it belongs to that document.
    if (message.type === "document.hook-installed") this.documents.release(key, message.documentId);
  }

  /** A CDP event of an instrumented session that is neither a context nor a binding event. */
  sessionEvent(record: TargetRecord, event: CdpEvent): void {
    this.storage(record)?.handle(event.method, event.params);
    if (event.method.startsWith("Network.")) {
      this.network(record).handle(event.method, event.params);
      return;
    }
    const mapped = mapPageEvent(event.method, event.params);
    if (!mapped) return;
    const contextFrame =
      mapped.contextId === undefined ? undefined : record.contexts.get(mapped.contextId);
    const origin = this.origin(record, mapped.frameId ?? contextFrame ?? null);
    if (mapped.contextId === undefined) this.emitter.emit(origin, mapped.draft);
    else
      this.documents.emit(`${record.sessionId}:${mapped.contextId}`, (documentId) =>
        this.emitter.emit({ ...origin, documentId }, mapped.draft),
      );
    if (event.method === "Page.frameNavigated" && mapped.frameId)
      this.reread(record, mapped.frameId);
  }

  /** Settles every body still loading and every held event; nothing is emitted afterwards. */
  stop(): void {
    for (const network of this.networks.values())
      network.close("Capture stopped before the response finished loading.");
    this.networks.clear();
    for (const storage of this.storages.values()) storage.close();
    this.storages.clear();
    this.documents.releaseAll();
  }

  // Chrome can hand a window, script context and hook included, to the frame's next document
  // (a popup's about:blank): reading the hook there starts the new identity, so the frame's
  // events wait for that install, or the read's answer, instead of carrying the old document.
  private reread(record: TargetRecord, frameId: string): void {
    for (const [contextId, contextFrame] of record.contexts) {
      if (contextFrame !== frameId) continue;
      const key = `${record.sessionId}:${contextId}`;
      this.documents.hold(key);
      const params = {
        expression: READ_HOOK_DOCUMENT,
        contextId,
        returnByValue: true,
        silent: true,
      };
      const read = this.channel.send("Runtime.evaluate", params, record.sessionId);
      this.track(
        withDeadline(read, DOCUMENT_READ_TIMEOUT_MS).then(
          (reply) => this.documents.release(key, documentRead(reply)),
          () => this.documents.release(key, null),
        ),
      );
    }
  }

  private origin(record: TargetRecord, frameId: string | null): Origin {
    return {
      producer: `cdp:${record.sessionId}`,
      source: record.sessionId,
      targetId: record.info.targetId,
      frameId,
      documentId: null,
    };
  }

  private storage(record: TargetRecord): StorageCapture | undefined {
    const { type, targetId } = record.info;
    if (type !== "page" && type !== "iframe") return undefined;
    let storage = this.storages.get(record.sessionId);
    if (!storage) {
      const pollMs =
        type === "page" ? (this.options.cookiePollMs ?? DEFAULT_COOKIE_POLL_MS) : undefined;
      storage = new StorageCapture(this.session(record), targetId, pollMs);
      this.storages.set(record.sessionId, storage);
    }
    return storage;
  }

  private session(record: TargetRecord): StorageSession {
    return {
      send: (method, params) => this.channel.send(method, params, record.sessionId),
      emit: (draft, frameId) => this.emitter.emit(this.origin(record, frameId), draft),
      track: this.track,
    };
  }

  private network(record: TargetRecord): NetworkCapture {
    let network = this.networks.get(record.sessionId);
    if (!network) {
      network = new NetworkCapture({
        ...this.session(record),
        bodyTimeoutMs: this.options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
        // A longer inline body would fail the journal schema and be dropped instead of truncated.
        maxBodyLength: Math.min(
          this.options.maxBodyLength ?? MAX_INLINE_BODY_LENGTH,
          MAX_INLINE_BODY_LENGTH,
        ),
        sensitive: sensitiveHeaders(this.options.redactHeaders),
        ...(this.options.blobs && { blobs: this.options.blobs }),
      });
      this.networks.set(record.sessionId, network);
    }
    return network;
  }
}

function observedDraft(message: ObserverMessage): Draft {
  if (message.kind === "dom")
    return {
      category: "dom",
      type: message.type,
      component: "application",
      payload: message.payload,
    };
  if (message.kind === "storage") {
    const payload = { observation: "observed-operation", ...message.payload };
    return { category: "storage", type: "operation", component: "application", payload };
  }
  return {
    category: "target",
    type: "hook-installed",
    component: "collector",
    payload: message.payload,
  };
}

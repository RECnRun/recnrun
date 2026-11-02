import {
  MAX_INLINE_BODY_LENGTH,
  type CapturedEvent,
  type ObserverMessage,
} from "@recnrun/protocol";
import type { CdpChannel, CdpEvent } from "./cdp-socket.ts";
import { createEmitter, type Draft, type Emitter, type Origin } from "./capture-envelope.ts";
import { NetworkCapture } from "./capture-network.ts";
import { mapPageEvent } from "./capture-page.ts";
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
}

const DEFAULT_BODY_TIMEOUT_MS = 10_000;
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
  // The document the hook last reported from an execution context, by session and context id.
  private readonly documents = new Map<string, string>();
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

  detached(record: TargetRecord): void {
    this.networks
      .get(record.sessionId)
      ?.close("The target went away before the response finished loading.");
    this.networks.delete(record.sessionId);
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
    this.documents.set(`${record.sessionId}:${contextId}`, message.documentId);
    const origin = { ...this.origin(record, frameId), documentId: message.documentId };
    const draft: Draft =
      message.kind === "dom"
        ? {
            category: "dom",
            type: message.type,
            component: "application",
            payload: message.payload,
          }
        : {
            category: "target",
            type: "hook-installed",
            component: "collector",
            payload: message.payload,
          };
    this.emitter.emit(origin, { ...draft, monotonicTimeMs: message.ts });
  }

  /** A CDP event of an instrumented session that is neither a context nor a binding event. */
  sessionEvent(record: TargetRecord, event: CdpEvent): void {
    if (event.method.startsWith("Network.")) {
      this.network(record).handle(event.method, event.params);
      return;
    }
    const mapped = mapPageEvent(event.method, event.params);
    if (!mapped) return;
    const contextFrame =
      mapped.contextId === undefined ? undefined : record.contexts.get(mapped.contextId);
    const origin = this.origin(record, mapped.frameId ?? contextFrame ?? null);
    if (mapped.contextId !== undefined)
      origin.documentId = this.documents.get(`${record.sessionId}:${mapped.contextId}`) ?? null;
    this.emitter.emit(origin, mapped.draft);
  }

  /** Settles every body still loading; nothing is emitted afterwards. */
  stop(): void {
    for (const network of this.networks.values())
      network.close("Capture stopped before the response finished loading.");
    this.networks.clear();
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

  private network(record: TargetRecord): NetworkCapture {
    let network = this.networks.get(record.sessionId);
    if (!network) {
      network = new NetworkCapture({
        send: (method, params) => this.channel.send(method, params, record.sessionId),
        emit: (draft, frameId) => this.emitter.emit(this.origin(record, frameId), draft),
        track: this.track,
        bodyTimeoutMs: this.options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
        // A longer inline body would fail the journal schema and be dropped instead of truncated.
        maxBodyLength: Math.min(
          this.options.maxBodyLength ?? MAX_INLINE_BODY_LENGTH,
          MAX_INLINE_BODY_LENGTH,
        ),
      });
      this.networks.set(record.sessionId, network);
    }
    return network;
  }
}

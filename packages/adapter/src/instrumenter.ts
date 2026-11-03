import {
  OBSERVER_BINDING,
  type InstallMode,
  type InstrumentationEvent,
  type ObserverMessage,
  type InstrumentationReport,
} from "@recnrun/protocol";
import * as v from "valibot";
import { Capture, type CaptureOptions } from "./capture.ts";
import type { CdpChannel, CdpEvent } from "./cdp-socket.ts";
import {
  installCommands,
  isInstrumented,
  RESUME,
  type InstrumentedType,
} from "./instrumentation-install.ts";
import {
  AttachedSchema,
  BindingCalledSchema,
  DetachedSchema,
  judge,
  newRecord,
  trackContext,
  type TargetRecord,
} from "./instrumentation-targets.ts";
import type { TargetScope } from "./instrumentation-scope.ts";
import { ObserverDelivery } from "./observer-delivery.ts";

export interface InstrumentOptions {
  onEvent?: (event: InstrumentationEvent) => void;
  /** Captures raw events into journal lines; without it only the hook is installed. */
  capture?: CaptureOptions;
  now?: () => Date;
  openChannel?: (endpoint: string) => Promise<CdpChannel>;
  /** Limits instrumentation to these targets; without it every target is instrumented. */
  scope?: TargetScope;
  /** How many unacknowledged messages each hooked document keeps before it reports a gap. */
  observerBuffer?: number;
}

const CONTEXT_EVENTS = new Set([
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
]);

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ContextIdSchema = v.object({ executionContextId: v.number() });

/** Tracks every target of one channel: installs the hook, receives its messages, and captures. */
export class Instrumenter {
  readonly records: TargetRecord[] = [];
  private readonly sessions = new Map<string, TargetRecord>();
  readonly pending = new Set<Promise<void>>();
  private readonly channel: CdpChannel;
  private readonly options: InstrumentOptions;
  readonly capture: Capture | undefined;
  readonly delivery: ObserverDelivery;

  constructor(channel: CdpChannel, options: InstrumentOptions) {
    this.channel = channel;
    this.options = options;
    this.delivery = new ObserverDelivery({
      acknowledge: (sessionId, contextId, expression) => {
        const params = { expression, contextId, silent: true };
        void channel.send("Runtime.evaluate", params, sessionId).catch(() => undefined);
      },
    });
    const now = options.now ?? (() => new Date());
    this.capture =
      options.capture &&
      new Capture(channel, { ...options.capture, now }, (work) => this.track(work));
  }

  track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  handle(event: CdpEvent): void {
    if (event.method === "Target.attachedToTarget") this.attach(event.params, event.sessionId);
    else if (event.method === "Target.detachedFromTarget") this.detach(event.params);
    else {
      const record = event.sessionId ? this.sessions.get(event.sessionId) : undefined;
      if (!record) return;
      if (CONTEXT_EVENTS.has(event.method)) {
        trackContext(record, event.method, event.params);
        this.contextEnded(record, event.method, event.params);
      } else if (event.method === "Runtime.bindingCalled") this.receive(record, event.params);
      else if (record.info.installMode !== "ignored") this.capture?.sessionEvent(record, event);
    }
  }

  private attach(params: unknown, parent: string | undefined): void {
    const attached = v.safeParse(AttachedSchema, params);
    if (!attached.success) return;
    const { sessionId, targetInfo, waitingForDebugger } = attached.output;
    const { targetId, type, url, openerId } = targetInfo;
    const viaInstrumented = parent === undefined ? undefined : this.sessions.has(parent);
    const { scope } = this.options;
    if (scope && !scope.admits({ targetId, type, openerId, viaInstrumented })) {
      this.track(this.release(sessionId, waitingForDebugger));
      return;
    }
    const mode: InstallMode = !isInstrumented(type)
      ? "ignored"
      : waitingForDebugger
        ? "before-first-script"
        : "late";
    const record = newRecord(sessionId, { targetId, type, url, installMode: mode });
    this.records.push(record);
    this.sessions.set(sessionId, record);
    this.capture?.attached(record, openerId);
    this.track(
      isInstrumented(type)
        ? this.install(record, type, mode)
        : this.resumeIgnored(sessionId, waitingForDebugger),
    );
  }

  // Sent in one burst without awaiting replies: Chrome runs a session's commands in order, a held
  // worker answers nothing until resumed, and another client's resume releases a held popup.
  private async install(record: TargetRecord, type: InstrumentedType, mode: InstallMode) {
    const commands = installCommands(type, record.info.targetId, mode, {
      capture: Boolean(this.capture),
      buffer: this.options.observerBuffer,
    });
    const replies = commands.map(({ method, params }) =>
      this.channel.send(method, params, record.sessionId),
    );
    this.capture?.started(record);
    const failed = (await Promise.allSettled(replies)).find((each) => each.status === "rejected");
    if (failed) record.info.error = reason(failed.reason);
  }

  private async resumeIgnored(sessionId: string, waiting: boolean) {
    if (!waiting) return;
    await this.channel.send(RESUME.method, RESUME.params, sessionId).catch(() => undefined);
  }

  // Outside the scope: resumed when held, then detached, so nothing is installed or captured there.
  private async release(sessionId: string, waiting: boolean) {
    await this.resumeIgnored(sessionId, waiting);
    await this.channel.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  private detach(params: unknown): void {
    const detached = v.safeParse(DetachedSchema, params);
    if (!detached.success) return;
    const record = this.sessions.get(detached.output.sessionId);
    if (record) {
      record.info.detached = true;
      this.closeDocuments((sessionId) => sessionId === record.sessionId);
      this.capture?.detached(record);
    }
    this.sessions.delete(detached.output.sessionId);
  }

  private receive(record: TargetRecord, params: unknown): void {
    const { info } = record;
    // An ignored target never gets the binding; whatever it calls is not ours.
    if (info.installMode === "ignored") return;
    const called = v.safeParse(BindingCalledSchema, params);
    if (!called.success || called.output.name !== OBSERVER_BINDING) return;
    const verdict = judge(record, called.output.payload, called.output.executionContextId);
    if (!verdict.ok) return;
    const { message, frameId } = verdict;
    const arrival = this.delivery.arrive(
      record.sessionId,
      called.output.executionContextId,
      message,
    );
    if (arrival === "invalid") info.droppedInvalid += 1;
    if (arrival !== "new") return;
    this.capture?.observed(record, message, frameId, called.output.executionContextId);
    if (message.type === "document.hook-installed") this.installed(record, message, frameId);
  }

  private installed(
    record: TargetRecord,
    message: Extract<ObserverMessage, { kind: "lifecycle" }>,
    frameId: string | null,
  ): void {
    const { info } = record;
    const { installMode } = info;
    if (installMode === "ignored") return;
    info.hookInstalled = true;
    info.hookInstalls += 1;
    // Chrome attaches an OOPIF or a popup before it navigates; its main frame's id is the target id.
    if (frameId === info.targetId) info.url = message.payload.url;
    record.seq += 1;
    this.options.onEvent?.({
      type: message.type,
      source: record.sessionId,
      seq: record.seq,
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      targetId: info.targetId,
      sessionId: record.sessionId,
      frameId,
      documentId: message.documentId,
      installMode,
      hookSeq: message.seq,
      monotonicTimeMs: message.ts,
      url: message.payload.url,
    });
  }

  /** Journals the sequence numbers of ended documents that no message or gap accounted for. */
  closeDocuments(matches: (sessionId: string, contextId: number) => boolean): void {
    for (const hole of this.delivery.close(matches)) {
      const record = this.sessions.get(hole.sessionId);
      if (record) this.capture?.undelivered(record, hole);
    }
  }

  private contextEnded(record: TargetRecord, method: string, params: unknown): void {
    const ofSession = (sessionId: string) => sessionId === record.sessionId;
    if (method === "Runtime.executionContextsCleared") this.closeDocuments(ofSession);
    const destroyed = v.safeParse(ContextIdSchema, params);
    if (method !== "Runtime.executionContextDestroyed" || !destroyed.success) return;
    const { executionContextId } = destroyed.output;
    this.closeDocuments(
      (sessionId, contextId) => ofSession(sessionId) && contextId === executionContextId,
    );
  }

  report(): InstrumentationReport {
    const targets = this.records.map(({ info }) => ({ ...info }));
    const observed = (type: string) => ({ observed: targets.some((t) => t.type === type) });
    return {
      targets,
      dedicatedWorkers: observed("worker"),
      serviceWorkers: observed("service_worker"),
      ...(this.capture && { capture: this.capture.counts() }),
    };
  }
}

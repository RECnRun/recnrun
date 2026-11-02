import {
  OBSERVER_BINDING,
  type InstallMode,
  type InstrumentationEvent,
  type ObserverMessage,
  type InstrumentationReport,
} from "@recnrun/protocol";
import * as v from "valibot";
import { Capture, type CaptureOptions } from "./capture.ts";
import { openCdpChannel, type CdpChannel, type CdpEvent } from "./cdp-socket.ts";
import {
  AUTO_ATTACH,
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

export interface InstrumentOptions {
  onEvent?: (event: InstrumentationEvent) => void;
  /** Captures raw events into journal lines; without it only the hook is installed. */
  capture?: CaptureOptions;
  now?: () => Date;
  openChannel?: (endpoint: string) => Promise<CdpChannel>;
}

export interface Instrumentation {
  /** Every target attached so far, with its install mode and drop counters. */
  report(): InstrumentationReport;
  /** Resolves once every install and body read started so far has finished. */
  settled(): Promise<void>;
  /** Records bodies still loading as unavailable and closes the socket. */
  stop(): void;
}

const CONTEXT_EVENTS = new Set([
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
]);

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

class Instrumenter {
  readonly records: TargetRecord[] = [];
  private readonly sessions = new Map<string, TargetRecord>();
  readonly pending = new Set<Promise<void>>();
  private readonly channel: CdpChannel;
  private readonly options: InstrumentOptions;
  readonly capture: Capture | undefined;

  constructor(channel: CdpChannel, options: InstrumentOptions) {
    this.channel = channel;
    this.options = options;
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
    if (event.method === "Target.attachedToTarget") this.attach(event.params);
    else if (event.method === "Target.detachedFromTarget") this.detach(event.params);
    else {
      const record = event.sessionId ? this.sessions.get(event.sessionId) : undefined;
      if (!record) return;
      if (CONTEXT_EVENTS.has(event.method)) trackContext(record, event.method, event.params);
      else if (event.method === "Runtime.bindingCalled") this.receive(record, event.params);
      else if (record.info.installMode !== "ignored") this.capture?.sessionEvent(record, event);
    }
  }

  private attach(params: unknown): void {
    const attached = v.safeParse(AttachedSchema, params);
    if (!attached.success) return;
    const { sessionId, targetInfo, waitingForDebugger } = attached.output;
    const { targetId, type, url, openerId } = targetInfo;
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
    const commands = installCommands(type, record.info.targetId, mode, Boolean(this.capture));
    const replies = commands.map(({ method, params }) =>
      this.channel.send(method, params, record.sessionId),
    );
    const failed = (await Promise.allSettled(replies)).find((each) => each.status === "rejected");
    if (failed) record.info.error = reason(failed.reason);
  }

  private async resumeIgnored(sessionId: string, waiting: boolean) {
    if (!waiting) return;
    await this.channel.send(RESUME.method, RESUME.params, sessionId).catch(() => undefined);
  }

  private detach(params: unknown): void {
    const detached = v.safeParse(DetachedSchema, params);
    if (!detached.success) return;
    const record = this.sessions.get(detached.output.sessionId);
    if (record) {
      record.info.detached = true;
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

/**
 * Instruments every target over `channel`: browser-level auto-attach holds each new target with
 * `waitForDebuggerOnStart` until its hook, binding, and nested auto-attach are installed.
 */
export async function instrumentChannel(
  channel: CdpChannel,
  options: InstrumentOptions = {},
): Promise<Instrumentation> {
  const instrumenter = new Instrumenter(channel, options);
  channel.onEvent((event) => instrumenter.handle(event));
  await channel.send(AUTO_ATTACH.method, AUTO_ATTACH.params);
  return {
    report: () => instrumenter.report(),
    settled: async () => {
      while (instrumenter.pending.size > 0) await Promise.all(instrumenter.pending);
    },
    stop: () => {
      instrumenter.capture?.stop();
      channel.close();
    },
  };
}

/** Opens a CDP socket of its own to `endpoint` and instruments every target there. */
export async function instrument(
  endpoint: string,
  options: InstrumentOptions = {},
): Promise<Instrumentation> {
  const channel = await (options.openChannel ?? openCdpChannel)(endpoint);
  return instrumentChannel(channel, options);
}

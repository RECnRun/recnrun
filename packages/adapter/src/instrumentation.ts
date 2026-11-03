import type { InstrumentationReport } from "@recnrun/protocol";
import { openCdpChannel, type CdpChannel } from "./cdp-socket.ts";
import { AUTO_ATTACH } from "./instrumentation-install.ts";
import { Instrumenter, type InstrumentOptions } from "./instrumenter.ts";
import { assertLoopbackEndpoint } from "./loopback.ts";

export type { InstrumentOptions } from "./instrumenter.ts";

export interface Instrumentation {
  /** Every target attached so far, with its install mode and drop counters. */
  report(): InstrumentationReport;
  /** Resolves once every install and body read started so far has finished. */
  settled(): Promise<void>;
  /** Stops starting new storage reads, then waits for what is under way, at most `drainTimeoutMs`. */
  drain(): Promise<void>;
  /** Evaluates `expression` in every hooked document still open; a failure is ignored. */
  evaluateInDocuments(expression: string): Promise<void>;
  /** Records bodies still loading as unavailable and closes the socket. */
  stop(): void;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/** `settled` within `ms`; past it, the failure counts the operations that were still pending. */
function drained(
  settled: Promise<void>,
  pending: ReadonlySet<Promise<void>>,
  ms = DEFAULT_DRAIN_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const left = pending.size;
      const were = left === 1 ? "operation was" : "operations were";
      reject(new Error(`Capture did not settle within ${ms} ms; ${left} ${were} still pending.`));
    }, ms);
  });
  return Promise.race([settled, deadline]).finally(() => clearTimeout(timer));
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
  // A socket that closes on its own ends every document and settles capture under way as lost.
  channel.onClose(() => {
    instrumenter.closeDocuments(() => true);
    instrumenter.capture?.lost();
  });
  const stop = () => {
    instrumenter.closeDocuments(() => true);
    instrumenter.capture?.stop();
    channel.close();
  };
  try {
    await channel.send(AUTO_ATTACH.method, AUTO_ATTACH.params);
  } catch (error) {
    // Nobody gets a handle to stop, so the channel and any capture started so far end here.
    stop();
    throw error;
  }
  const settled = async () => {
    while (instrumenter.pending.size > 0) await Promise.all(instrumenter.pending);
  };
  return {
    report: () => instrumenter.report(),
    settled,
    drain: () => {
      instrumenter.capture?.quiesce();
      return drained(settled(), instrumenter.pending, options.drainTimeoutMs);
    },
    evaluateInDocuments: async (expression) => {
      const sends = instrumenter.delivery
        .documents()
        .map(({ sessionId, contextId }) =>
          channel.send("Runtime.evaluate", { expression, contextId, silent: true }, sessionId),
        );
      await Promise.allSettled(sends);
    },
    stop,
  };
}

/** Opens a CDP socket of its own to `endpoint` and instruments every target there. */
export async function instrument(
  endpoint: string,
  options: InstrumentOptions = {},
): Promise<Instrumentation> {
  assertLoopbackEndpoint(endpoint);
  const channel = await (options.openChannel ?? openCdpChannel)(endpoint);
  return instrumentChannel(channel, options);
}

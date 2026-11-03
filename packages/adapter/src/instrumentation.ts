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
  /** Evaluates `expression` in every hooked document still open; a failure is ignored. */
  evaluateInDocuments(expression: string): Promise<void>;
  /** Records bodies still loading as unavailable and closes the socket. */
  stop(): void;
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
  return {
    report: () => instrumenter.report(),
    settled: async () => {
      while (instrumenter.pending.size > 0) await Promise.all(instrumenter.pending);
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

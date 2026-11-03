import type { CaptureHandle, CaptureSink, ReplayBlobs } from "@recnrun/engine";
import type { Page } from "playwright-core";
import * as v from "valibot";
import { withDeadline } from "./capture-documents.ts";
import { createEmitter, type Origin } from "./capture-envelope.ts";
import type { BodySink } from "./capture-network-evidence.ts";
import { openCdpChannel, type CdpChannel } from "./cdp-socket.ts";
import { instrumentChannel, type Instrumentation } from "./instrumentation.ts";
import { TargetScope } from "./instrumentation-scope.ts";
import { assertLoopbackEndpoint } from "./loopback.ts";
import type { CaptureSession } from "./replay-capture.ts";
import type { ReplayPage } from "./replay-page.ts";

/** Capture of the replay's own tabs over a CDP socket of its own, as a recording session does. */
export interface ReplayObserver extends CaptureHandle {
  /** Captures a tab replay opened, before it navigates; a failure is journaled as a gap. */
  adopt(page: ReplayPage): Promise<void>;
  /** Runs `work` with the hooks of the replay's documents muted for at most `ms` (see `hook-source.ts`). */
  muted<T>(work: () => Promise<T>, ms: number): Promise<T>;
  stop(): void;
}

export interface ObserveOptions {
  openChannel?: (endpoint: string) => Promise<CdpChannel>;
  now?: () => Date;
}

const ADOPT_TIMEOUT_MS = 5000;
const ORIGIN: Origin = {
  producer: "adapter:replay",
  source: "adapter",
  targetId: null,
  frameId: null,
  documentId: null,
};
const TargetInfoReply = v.object({
  targetInfo: v.object({ targetId: v.pipe(v.string(), v.nonEmpty()) }),
});
const AttachReply = v.object({ sessionId: v.pipe(v.string(), v.nonEmpty()) });

async function targetIdOf(page: ReplayPage): Promise<string> {
  const session = (await page.context().newCDPSession(page as Page)) as CaptureSession;
  try {
    const reply = await session.send("Target.getTargetInfo");
    return v.parse(TargetInfoReply, reply).targetInfo.targetId;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

// Text bodies reach the run as strings, so it can redact the secrets a response echoes.
function textBodies(blobs: ReplayBlobs): BodySink {
  const decoder = new TextDecoder();
  return {
    put: (content, meta) =>
      blobs.put(meta.encoding === "utf8" ? decoder.decode(content) : content, meta),
  };
}

// Chrome runs each evaluate before input sent after its reply, so the mute spans the work exactly.
async function mutedIn<T>(
  instrumentation: Instrumentation,
  work: () => Promise<T>,
  ms: number,
): Promise<T> {
  const mute = (value: number) =>
    instrumentation.evaluateInDocuments(`globalThis.__recnrunHook?.mute?.(${value})`);
  await mute(ms);
  try {
    return await work();
  } finally {
    await mute(0);
  }
}

/** Instruments the tabs `adopt` names and the popups and frames they open, into `sink`. */
export async function observeReplay(
  endpoint: string,
  sink: CaptureSink,
  options: ObserveOptions = {},
): Promise<ReplayObserver> {
  assertLoopbackEndpoint(endpoint);
  const now = options.now ?? (() => new Date());
  const channel = await (options.openChannel ?? openCdpChannel)(endpoint);
  const scope = new TargetScope([]);
  const onEvent = sink.event.bind(sink);
  const blobs = sink.blobs && textBodies(sink.blobs);
  const instrumentation = await instrumentChannel(channel, {
    scope,
    now,
    capture: { runId: sink.runId, onEvent, ...(blobs && { blobs }) },
  });
  const gaps = createEmitter({ runId: sink.runId, onEvent, now });
  const lose = (reason: "target-unattached" | "capture-stopped") =>
    gaps.emit(ORIGIN, {
      category: "gap",
      type: reason,
      component: "collector",
      payload: { reason },
    });
  let stopped = false;
  const stop = () => {
    if (!stopped) instrumentation.stop();
    stopped = true;
  };
  const attach = async (page: ReplayPage) => {
    const targetId = await targetIdOf(page);
    scope.add(targetId);
    const reply = await channel.send("Target.attachToTarget", { targetId, flatten: true });
    const { sessionId } = v.parse(AttachReply, reply);
    // Chrome answers a session's commands in order: this one comes after what the attach installed.
    await channel.send("Runtime.evaluate", { expression: "0", silent: true }, sessionId);
  };
  return {
    async adopt(page) {
      if (stopped) return;
      await withDeadline(attach(page), ADOPT_TIMEOUT_MS).catch(() => lose("target-unattached"));
    },
    muted: async (work, ms) => mutedIn(instrumentation, work, ms),
    async drain() {
      await instrumentation.settled().catch(() => lose("capture-stopped"));
      stop();
    },
    stop,
  };
}

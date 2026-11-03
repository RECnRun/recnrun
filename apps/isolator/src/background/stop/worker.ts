import { withTimeout } from "@/background/probes/helpers";
import type { Debuggee, EventListener } from "@/background/probes/types";
import type { Outcome, Recorder } from "@/background/stop/recorder";
import { isListed, loopbackTab, loopbackTarget } from "@/background/stop/targets";

const PAUSE_WAIT_MS = 5_000;
// The forced statement answers only once the worker resumes, which the harness bounds itself.
const HELD_EVALUATION_MS = 120_000;

type Reply = Outcome<Record<string, unknown>>;

export type CloseRequest =
  | { targetId: string; via?: "worker" }
  | { targetId: string; via: "tab"; tabId: number };

/** Runs `run` on a session of the worker's own, detaching after it when the attach worked. */
async function onWorker<T>(
  recorder: Recorder,
  targetId: string,
  run: (worker: Debuggee) => Promise<T>,
): Promise<T> {
  const worker = { targetId };
  const attached = await recorder.attach(worker);
  try {
    return await run(worker);
  } finally {
    if (attached.error === undefined) await recorder.detach(worker);
  }
}

/** `Target.closeTarget` on the worker's own session, or through the tab session that auto-attached it. */
export async function closeTarget(recorder: Recorder, request: CloseRequest) {
  await loopbackTarget(recorder, request.targetId);
  const params = { targetId: request.targetId };
  let reply: Reply;
  if (request.via === "tab") {
    await loopbackTab(recorder, request.tabId);
    reply = await recorder.send({ tabId: request.tabId }, "Target.closeTarget", params);
  } else {
    reply = await onWorker(recorder, request.targetId, (worker) =>
      recorder.send(worker, "Target.closeTarget", params),
    );
  }
  return {
    via: request.via ?? "worker",
    success: reply.value?.success === true,
    listedAfter: await isListed(recorder, request.targetId),
  };
}

export async function terminateExecution(recorder: Recorder, targetId: string) {
  await loopbackTarget(recorder, targetId);
  const reply = await onWorker(recorder, targetId, (worker) =>
    recorder.send(worker, "Runtime.terminateExecution"),
  );
  return { terminated: reply.error === undefined };
}

/** Resolves on the worker session's `Debugger.paused`, recording when it came. */
function pausedEvent(recorder: Recorder, targetId: string) {
  const seen: { at?: number } = {};
  let resolve = (): void => undefined;
  const arrived = new Promise<void>((done) => {
    resolve = done;
  });
  const listener: EventListener = (source, method) => {
    if (method !== "Debugger.paused" || source.targetId !== targetId || source.sessionId) return;
    seen.at ??= recorder.now();
    resolve();
  };
  return { seen, arrived, listener };
}

/** Pauses the worker and leaves it paused; the returned evaluation settles once it resumes. */
export async function pauseHold(recorder: Recorder, targetId: string) {
  await loopbackTarget(recorder, targetId);
  const worker = { targetId };
  const paused = pausedEvent(recorder, targetId);
  recorder.debugger.onEvent.addListener(paused.listener);
  try {
    await recorder.attach(worker);
    await recorder.send(worker, "Debugger.enable");
    await recorder.send(worker, "Debugger.pause");
    // An idle worker runs no statement to pause on, so one is forced.
    const evaluation = recorder.send(
      worker,
      "Runtime.evaluate",
      { expression: "1" },
      HELD_EVALUATION_MS,
    );
    const arrived = await withTimeout(paused.arrived, "Debugger.paused", PAUSE_WAIT_MS).then(
      () => true,
      () => false,
    );
    const at = paused.seen.at;
    return {
      outcome: { paused: arrived, ...(at === undefined ? {} : { pausedAt: at }) },
      evaluation,
    };
  } finally {
    recorder.debugger.onEvent.removeListener(paused.listener);
  }
}

export async function release(recorder: Recorder, targetId: string, evaluation: Promise<Reply>) {
  const worker = { targetId };
  const resumed = await recorder.send(worker, "Debugger.resume");
  await recorder.send(worker, "Debugger.disable");
  await recorder.detach(worker);
  const held = await evaluation;
  return {
    resumed: resumed.error === undefined,
    heldEvaluation: held.error === undefined ? held.value : { error: held.error },
  };
}

import { workerScriptPatterns } from "@/background/probes/domains";
import {
  attachTarget,
  attempt,
  expectEffect,
  findTarget,
  messageOf,
  send,
  unavailable,
  waitFor,
  withTimeout,
} from "@/background/probes/helpers";
import { workerTargetId } from "@/background/probes/targets";
import type {
  Debuggee,
  EventListener,
  ProbeContext,
  ProbeDefinition,
} from "@/background/probes/types";

/** How long `Debugger.pause` may take to produce `Debugger.paused`. */
const PAUSE_WINDOW_MS = 2_000;
/** Time for Chrome to drop a closed target from getTargets(). */
const CLOSE_SETTLE_MS = 500;

/** The service worker session, attached by target id once per run. */
async function serviceWorker(context: ProbeContext): Promise<Debuggee> {
  if (context.state.serviceWorkerSession) return context.state.serviceWorkerSession;
  const worker = findTarget(context.state.targets, context.urls.serviceWorkerUrl);
  if (!worker) throw new Error("precondition: getTargets() listed no service worker");
  context.state.serviceWorkerSession = await attachTarget(context, worker.id);
  return context.state.serviceWorkerSession;
}

/** A probe on the service worker's own session; unavailable when the worker is not listed. */
function onServiceWorker(
  id: string,
  description: string,
  run: (context: ProbeContext, worker: Debuggee) => Promise<unknown>,
): ProbeDefinition {
  return {
    id,
    description,
    run: async (context) => {
      if (!findTarget(context.state.targets, context.urls.serviceWorkerUrl)) {
        return unavailable("getTargets() listed no service worker");
      }
      return attempt(async () => run(context, await serviceWorker(context)));
    },
  };
}

const evaluate = onServiceWorker(
  "worker-runtime-evaluate",
  "Runtime.evaluate on the service worker session (attach by targetId)",
  async (context, worker) => {
    const reply = await send(context, worker, "Runtime.evaluate", {
      expression: "self.location.pathname",
      returnByValue: true,
    });
    const exception = reply.exceptionDetails as { text?: string } | undefined;
    expectEffect(!exception, `Runtime.evaluate threw: ${exception?.text ?? "unknown exception"}`);
    const value = (reply.result as { value?: unknown } | undefined)?.value;
    expectEffect(typeof value === "string", "Runtime.evaluate returned no string value");
    return { value };
  },
);

const fetchEnable = onServiceWorker(
  "worker-fetch-enable",
  "Fetch.enable with worker-script patterns on the service worker session",
  async (context, worker) => {
    await send(context, worker, "Fetch.enable", { patterns: workerScriptPatterns(context.urls) });
    await send(context, worker, "Fetch.disable");
  },
);

const serviceWorkerEnable = onServiceWorker(
  "worker-service-worker-enable",
  "ServiceWorker.enable on the service worker session",
  async (context, worker) => {
    await send(context, worker, "ServiceWorker.enable");
    await send(context, worker, "ServiceWorker.disable");
  },
);

/** Sends `Debugger.pause` and reports whether `Debugger.paused` arrived from `worker` in time. */
async function pauseWorker(context: ProbeContext, worker: Debuggee): Promise<boolean> {
  let paused = false;
  const listener: EventListener = (source, method) => {
    if (method === "Debugger.paused" && source.targetId === worker.targetId) paused = true;
  };
  context.api.onEvent.addListener(listener);
  try {
    await send(context, worker, "Debugger.pause");
    // An idle worker pauses only when script runs, so run some.
    const evaluation = send(context, worker, "Runtime.evaluate", { expression: "1" }).catch(
      messageOf,
    );
    await waitFor(context, () => paused, PAUSE_WINDOW_MS);
    // Chrome refuses Debugger.resume when nothing is paused.
    if (paused) await send(context, worker, "Debugger.resume");
    await evaluation;
    return paused;
  } finally {
    context.api.onEvent.removeListener(listener);
  }
}

const pause = onServiceWorker(
  "worker-debugger-pause",
  "Debugger.pause then Debugger.resume on the service worker session",
  async (context, worker) => {
    await send(context, worker, "Debugger.enable");
    const paused = await pauseWorker(context, worker);
    await send(context, worker, "Debugger.disable");
    const missing = `Debugger.pause accepted but no Debugger.paused event within ${PAUSE_WINDOW_MS} ms`;
    expectEffect(paused, missing);
    return { pausedEventArrived: true };
  },
);

const terminate: ProbeDefinition = {
  id: "worker-terminate-execution",
  description: "Runtime.terminateExecution on the dedicated worker (attach by targetId)",
  run: async (context) => {
    const targetId = workerTargetId(context, context.urls.dedicatedWorkerUrl);
    if (!targetId) return unavailable("no dedicated worker target id");
    return attempt(async () => {
      const worker = await attachTarget(context, targetId);
      await send(context, worker, "Runtime.terminateExecution");
    });
  },
};

const closeTarget = onServiceWorker(
  "worker-close-target",
  "Target.closeTarget on the service worker, sent on its own session",
  async (context, worker) => {
    const { success } = await send(context, worker, "Target.closeTarget", {
      targetId: worker.targetId,
    });
    expectEffect(success === true, `Target.closeTarget returned success=${String(success)}`);
    await context.wait(CLOSE_SETTLE_MS);
    const targets = await withTimeout(context.api.getTargets(), "getTargets");
    const listedAfter = targets.some((target) => target.id === worker.targetId);
    const missing = `worker still listed by getTargets() ${CLOSE_SETTLE_MS} ms after Target.closeTarget`;
    expectEffect(!listedAfter, missing);
    return { success, listedAfter };
  },
);

export const WORKER_PROBES: ProbeDefinition[] = [
  evaluate,
  fetchEnable,
  serviceWorkerEnable,
  pause,
  terminate,
  closeTarget,
];

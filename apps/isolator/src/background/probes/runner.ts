import { AUTO_ATTACH_PROBES, autoAttachListener } from "@/background/probes/auto-attach";
import { TAB_DOMAIN_PROBES } from "@/background/probes/domains";
import { attempt, expectEffect, messageOf, withTimeout } from "@/background/probes/helpers";
import { assertLoopbackTargets } from "@/background/probes/loopback";
import { ATTACH_DEDICATED_PROBE, TARGET_PROBES } from "@/background/probes/targets";
import type {
  DebuggerApi,
  DetachListener,
  ProbeContext,
  ProbeDefinition,
  ProbeResult,
  ProbeTargets,
} from "@/background/probes/types";
import { WORKER_PROBES } from "@/background/probes/workers";

/** Time for `onDetach` events to arrive after the last detach. */
const DETACH_SETTLE_MS = 500;

const cleanup: ProbeDefinition = {
  id: "cleanup",
  description: "detach every remaining session; chrome.debugger.onDetach reasons",
  run: (context) =>
    attempt(async () => {
      const { state } = context;
      const remaining = [...state.attached];
      if (state.tabAttached && state.tabId !== undefined) remaining.push({ tabId: state.tabId });
      const detached = await Promise.all(
        remaining.map((debuggee) =>
          withTimeout(context.api.detach(debuggee), "detach").then(
            () => "ok",
            (error: unknown) => messageOf(error),
          ),
        ),
      );
      state.attached = [];
      state.tabAttached = false;
      const failures = [...new Set(detached.filter((outcome) => outcome !== "ok"))];
      expectEffect(failures.length === 0, failures.join(" | "));
      await context.wait(DETACH_SETTLE_MS);
      return {
        detached,
        onDetach: state.detaches.map(({ source, reason }) => ({
          kind: source.tabId === undefined ? "target" : "tab",
          reason,
        })),
      };
    }),
};

/** Probes in run order: each may read what earlier ones left in the context's state. */
export const PROBES: readonly ProbeDefinition[] = [
  ...TARGET_PROBES,
  ...AUTO_ATTACH_PROBES,
  ATTACH_DEDICATED_PROBE,
  ...TAB_DOMAIN_PROBES,
  ...WORKER_PROBES,
  cleanup,
];

/** Runs every probe in order; a probe that throws becomes `rejected` with its message. */
export async function runProbes(
  probes: readonly ProbeDefinition[],
  context: ProbeContext,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    try {
      results.push({ id: probe.id, ...(await probe.run(context)) });
    } catch (error) {
      results.push({ id: probe.id, status: "rejected", error: messageOf(error) });
    }
  }
  return results;
}

export function createContext(
  api: DebuggerApi,
  urls: ProbeTargets,
  wait: (ms: number) => Promise<void>,
): ProbeContext {
  return {
    api,
    urls,
    wait,
    state: {
      targets: [],
      tabAttached: false,
      autoAttachSet: false,
      autoAttachPhase: "existing",
      autoAttached: [],
      attached: [],
      detaches: [],
    },
  };
}

/**
 * Runs the probe table against the fixture page with the event listeners the probes rely on.
 * Throws before any debugger call when a target URL is outside the loopback.
 */
export async function runAllProbes(
  api: DebuggerApi,
  urls: ProbeTargets,
  wait: (ms: number) => Promise<void>,
  probes: readonly ProbeDefinition[] = PROBES,
): Promise<ProbeResult[]> {
  assertLoopbackTargets(urls);
  const context = createContext(api, urls, wait);
  const onEvent = autoAttachListener(context);
  const onDetach: DetachListener = (source, reason) =>
    context.state.detaches.push({ source, reason });
  api.onEvent.addListener(onEvent);
  api.onDetach.addListener(onDetach);
  try {
    return await runProbes(probes, context);
  } finally {
    api.onEvent.removeListener(onEvent);
    api.onDetach.removeListener(onDetach);
  }
}

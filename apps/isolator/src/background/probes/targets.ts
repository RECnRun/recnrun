import {
  attachTarget,
  attempt,
  detachTarget,
  findTarget,
  unavailable,
  withTimeout,
} from "@/background/probes/helpers";
import type { ProbeContext, ProbeDefinition, ProbeTargets } from "@/background/probes/types";

type WorkerKey = keyof Pick<
  ProbeTargets,
  "serviceWorkerUrl" | "sharedWorkerUrl" | "dedicatedWorkerUrl"
>;

const WORKERS: { name: string; key: WorkerKey }[] = [
  { name: "service-worker", key: "serviceWorkerUrl" },
  { name: "shared-worker", key: "sharedWorkerUrl" },
  { name: "dedicated-worker", key: "dedicatedWorkerUrl" },
];

const getTargets: ProbeDefinition = {
  id: "get-targets",
  description: "chrome.debugger.getTargets() answers; the whole list with types and URLs",
  run: (context) =>
    attempt(async () => {
      const targets = await withTimeout(context.api.getTargets(), "getTargets");
      context.state.targets = targets;
      context.state.tabId = findTarget(targets, context.urls.pageUrl)?.tabId;
      return targets.map(({ type, url, attached, tabId }) => ({ type, url, attached, tabId }));
    }),
};

function listed(name: string, key: WorkerKey): ProbeDefinition {
  return {
    id: `get-targets-${name}`,
    description: `getTargets() lists the fixture's ${name}, with its type string`,
    run: async (context) => {
      const target = findTarget(context.state.targets, context.urls[key]);
      if (target) return { status: "allowed", detail: { type: target.type, url: target.url } };
      const types = [...new Set(context.state.targets.map((entry) => entry.type))].join(", ");
      return {
        status: "rejected",
        error: `not listed by chrome.debugger.getTargets() (types listed: ${types})`,
      };
    },
  };
}

/** The newest target id of a worker: auto-attach after the reload, else getTargets(). */
export function workerTargetId(context: ProbeContext, url: string): string | undefined {
  const reloaded = context.state.autoAttached.filter(
    (entry) => entry.phase === "after-reload" && entry.url.startsWith(url),
  );
  return reloaded.at(-1)?.targetId ?? findTarget(context.state.targets, url)?.id;
}

function attachable(name: string, key: WorkerKey): ProbeDefinition {
  return {
    id: `attach-${name}`,
    description: `attach({ targetId }) to the fixture's ${name}, then detach`,
    run: async (context) => {
      const targetId = workerTargetId(context, context.urls[key]);
      if (!targetId) return unavailable(`no ${name} target id from getTargets() or auto-attach`);
      return attempt(async () => {
        const debuggee = await attachTarget(context, targetId);
        await detachTarget(context, debuggee);
        return { targetId };
      });
    },
  };
}

export const TARGET_PROBES: ProbeDefinition[] = [
  getTargets,
  ...WORKERS.map(({ name, key }) => listed(name, key)),
  ...WORKERS.slice(0, 2).map(({ name, key }) => attachable(name, key)),
];

/** Runs after auto-attach, which can supply the id when getTargets() does not list the worker. */
export const ATTACH_DEDICATED_PROBE = attachable("dedicated-worker", "dedicatedWorkerUrl");

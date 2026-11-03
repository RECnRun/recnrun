import type { Debuggee } from "@/background/probes/types";
import type { DetachRecord, TargetEvent } from "@/background/route-a/types";

/** The Target events that say whether a worker's session survived a stop and its restart (E8). */
const TARGET_EVENTS = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Target.targetInfoChanged",
]);

interface TargetParams {
  sessionId?: unknown;
  targetId?: unknown;
  waitingForDebugger?: unknown;
  targetInfo?: { targetId?: unknown; attached?: unknown };
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

function fieldsOf(params: TargetParams): Partial<TargetEvent> {
  const sessionId = text(params.sessionId);
  const targetId = text(params.targetId) ?? text(params.targetInfo?.targetId);
  const { waitingForDebugger } = params;
  const attached = params.targetInfo?.attached;
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(typeof waitingForDebugger === "boolean" ? { waitingForDebugger } : {}),
    ...(typeof attached === "boolean" ? { detail: attached ? "attached" : "detached" } : {}),
  };
}

/** The journal record of a Target event, or undefined (without reading the clock) for any other. */
export function targetEventOf(
  source: Debuggee,
  method: string,
  params: unknown,
  now: () => number,
): TargetEvent | undefined {
  if (!TARGET_EVENTS.has(method)) return undefined;
  const at = now();
  const via = source.sessionId === undefined ? {} : { via: source.sessionId };
  const fields = typeof params === "object" && params !== null ? fieldsOf(params) : {};
  return { at, method, ...via, ...fields };
}

/** The journal record of one `chrome.debugger.onDetach`. */
export function detachEventOf({ tabId, targetId }: Debuggee, record: DetachRecord): TargetEvent {
  return {
    at: record.at,
    method: "onDetach",
    ...(tabId === undefined ? {} : { tabId }),
    ...(targetId === undefined ? {} : { targetId }),
    detail: record.reason,
  };
}

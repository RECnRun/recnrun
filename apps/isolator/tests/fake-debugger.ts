import type {
  Debuggee,
  DebuggerApi,
  DetachListener,
  EventListener,
  ProbeResult,
  ProbeTargets,
  TargetInfo,
} from "@/background/probes/types";

// Probes refuse targets outside the loopback, as the E1 fixture's *.localhost hosts are.
const ORIGIN = "http://app.localhost:4600";
export const URLS: ProbeTargets = {
  pageUrl: `${ORIGIN}/workers.html`,
  serviceWorkerUrl: `${ORIGIN}/sw-main.js`,
  sharedWorkerUrl: `${ORIGIN}/shared-worker.js`,
  dedicatedWorkerUrl: `${ORIGIN}/worker.js`,
  iframeUrl: "http://idp.localhost:4602/whoami",
  cookieUrl: `${ORIGIN}/`,
};
export const NOT_ALLOWED = '{"code":-32000,"message":"Not allowed"}';
const TARGETS: TargetInfo[] = [
  { type: "page", id: "page", url: URLS.pageUrl, attached: false, tabId: 7 },
  { type: "worker", id: "sw", url: `${URLS.serviceWorkerUrl}?variant=classic`, attached: false },
  { type: "worker", id: "shared", url: `${URLS.sharedWorkerUrl}?type=classic`, attached: false },
];
/** What Chrome answers when the command had its effect. */
const REPLIES: Record<string, object> = {
  "Target.getTargets": { targetInfos: [{ type: "page", url: URLS.pageUrl }] },
  "Target.attachToTarget": { sessionId: "s-attached" },
  "Target.closeTarget": { success: true },
  "Network.setCookie": { success: true },
  "Storage.getCookies": { cookies: [] },
  "Page.addScriptToEvaluateOnNewDocument": { identifier: "1" },
  "Runtime.evaluate": { result: { type: "string", value: "/sw-main.js" } },
};

export const noWait = async () => undefined;

interface AttachedParams {
  sessionId?: string;
  targetInfo?: { targetId: string };
}

function listeners<T>() {
  const set = new Set<T>();
  return { set, addListener: (l: T) => set.add(l), removeListener: (l: T) => set.delete(l) };
}

export interface FakeOptions {
  /** Commands Chrome refuses, with its error text. */
  refused?: Record<string, string>;
  /** Replies that replace the ones of a command that had its effect. */
  replies?: Record<string, object>;
  /** Events Chrome never sends, as if it accepted the command without the effect. */
  muted?: string[];
  /** Commands Chrome never answers. */
  hanging?: string[];
  /** Commands a session answers only once it sent the named command, as a paused service worker. */
  heldUntil?: Record<string, string>;
  /** getTargets() keeps listing a target after Target.closeTarget. */
  keepsClosed?: boolean;
  /** detach() fails with this text. */
  detachError?: string;
  /** What getTargets() lists instead of the fixture's page, service worker, and shared worker. */
  targets?: TargetInfo[];
}

/** A fake chrome.debugger: answers every command, refuses ServiceWorker.*, auto-attaches workers. */
export function fakeDebugger(options: FakeOptions = {}) {
  const { refused = { "ServiceWorker.enable": NOT_ALLOWED }, replies = {}, muted = [] } = options;
  const onEvent = listeners<EventListener>();
  const onDetach = listeners<DetachListener>();
  const sent: { target: Debuggee; method: string; params?: object }[] = [];
  const closed = new Set<string>();
  const held = new Map<string, (() => void)[]>();
  const heldKey = (target: Debuggee, method: string) => `${target.sessionId ?? ""} ${method}`;
  const hold = (target: Debuggee, until: string, reply: object) =>
    new Promise<object>((resolve) => {
      const key = heldKey(target, until);
      held.set(key, [...(held.get(key) ?? []), () => resolve(reply)]);
    });
  // Auto-attached child sessions by id, with their target: Chrome keeps them across a stop (E8).
  const children = new Map<string, { source: Debuggee; targetId: string }>();
  const emit = (source: Debuggee, method: string, params?: object) => {
    const { sessionId, targetInfo } = (params ?? {}) as AttachedParams;
    if (method === "Target.attachedToTarget" && sessionId && targetInfo)
      children.set(sessionId, { source, targetId: targetInfo.targetId });
    if (!muted.includes(method))
      onEvent.set.forEach((listener) => listener(source, method, params));
  };
  /** Starts a stopped service worker again: Chrome holds it for a surviving session, unreported. */
  const restart = (targetId: string, sessionId: string): boolean => {
    const stale = [...children.values()].find((child) => child.targetId === targetId);
    if (stale) return false;
    const targetInfo = { targetId, type: "service_worker", url: `${URLS.serviceWorkerUrl}` };
    emit({ tabId: 7 }, "Target.attachedToTarget", {
      sessionId,
      targetInfo,
      waitingForDebugger: true,
    });
    return true;
  };
  const attachEvents = (source: Debuggee) => {
    for (const [type, url] of [
      ["worker", `${URLS.dedicatedWorkerUrl}?type=classic`],
      ["shared_worker", `${URLS.sharedWorkerUrl}?type=classic`],
      // Chrome reports a waiting iframe with an empty URL.
      ["iframe", ""],
    ]) {
      const targetInfo = { targetId: `${type}-new`, type, url };
      emit(source, "Target.attachedToTarget", {
        sessionId: `s-${type}`,
        targetInfo,
        waitingForDebugger: true,
      });
    }
  };
  const effects: Record<
    string,
    (target: Debuggee, params?: { targetId?: unknown; sessionId?: unknown }) => void
  > = {
    "Page.reload": attachEvents,
    "Debugger.pause": (target) => emit(target, "Debugger.paused"),
    "Target.closeTarget": (_, params) => {
      if (!options.keepsClosed) closed.add(String(params?.targetId));
    },
    "Target.detachFromTarget": (_, params) => {
      children.delete(String(params?.sessionId));
    },
  };
  const api: DebuggerApi = {
    getTargets: async () => (options.targets ?? TARGETS).filter((target) => !closed.has(target.id)),
    attach: async () => undefined,
    detach: async (target) => {
      if (options.detachError) throw new Error(options.detachError);
      onDetach.set.forEach((listener) => listener(target, "canceled_by_user"));
    },
    sendCommand: async (target, method, params) => {
      sent.push({ target, method, params });
      const error = refused[method];
      if (error) throw new Error(error);
      if (options.hanging?.includes(method)) return new Promise<never>(() => undefined);
      effects[method]?.(target, params);
      held.get(heldKey(target, method))?.forEach((answer) => answer());
      held.delete(heldKey(target, method));
      const reply = replies[method] ?? REPLIES[method] ?? {};
      const until = options.heldUntil?.[method];
      return until === undefined ? reply : hold(target, until, reply);
    },
    onEvent,
    onDetach,
  };
  return { api, sent, onEvent, onDetach, emit, restart };
}

export function byId(results: ProbeResult[]): Record<string, ProbeResult> {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

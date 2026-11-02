import {
  attempt,
  expectEffect,
  messageOf,
  PROTOCOL_VERSION,
  send,
  tabDebuggee,
  unavailable,
  waitFor,
  withTimeout,
} from "@/background/probes/helpers";
import type {
  AutoAttached,
  Debuggee,
  EventListener,
  ProbeContext,
  ProbeDefinition,
  ProbeTargets,
} from "@/background/probes/types";

/** How long the probe waits for the reloaded page's workers, then for the injected iframe. */
const AUTO_ATTACH_WINDOW_MS = 5_000;
/** Extra time for a target that may never come (the service worker). */
const AUTO_ATTACH_SETTLE_MS = 1_000;

/** The parameters of `Target.attachedToTarget`. */
export interface AttachedEvent {
  sessionId: string;
  waitingForDebugger: boolean;
  targetInfo: { targetId: string; type: string; url: string };
}

export function isAttachedEvent(params: unknown): params is AttachedEvent {
  if (typeof params !== "object" || params === null) return false;
  const { sessionId, targetInfo } = params as Partial<AttachedEvent>;
  return typeof sessionId === "string" && typeof targetInfo?.targetId === "string";
}

async function release(context: ProbeContext, source: Debuggee, entry: AutoAttached) {
  try {
    const session = { tabId: source.tabId, sessionId: entry.sessionId };
    await send(context, session, "Runtime.runIfWaitingForDebugger");
    entry.released = "ok";
  } catch (error) {
    entry.released = messageOf(error);
  }
}

/** Records every target the tab session auto-attaches and releases the ones waiting for us. */
export function autoAttachListener(context: ProbeContext): EventListener {
  return (source, method, params) => {
    if (method !== "Target.attachedToTarget" || source.sessionId !== undefined) return;
    if (source.tabId === undefined || source.tabId !== context.state.tabId) return;
    if (!isAttachedEvent(params)) return;
    const { sessionId, waitingForDebugger, targetInfo } = params;
    const { targetId, type, url } = targetInfo;
    const phase = context.state.autoAttachPhase;
    const entry: AutoAttached = { sessionId, targetId, type, url, waitingForDebugger, phase };
    context.state.autoAttached.push(entry);
    if (waitingForDebugger) void release(context, source, entry);
  };
}

type Matcher = (entry: AutoAttached, urls: ProbeTargets) => boolean;

const byUrl =
  (key: keyof ProbeTargets): Matcher =>
  (entry, urls) =>
    entry.url.startsWith(urls[key]);
// A waiting iframe target has an empty URL until it is released, so its type identifies it.
const isIframe: Matcher = (entry, urls) =>
  entry.type === "iframe" || byUrl("iframeUrl")(entry, urls);

function seen(context: ProbeContext, matches: Matcher): boolean {
  return context.state.autoAttached.some(
    (entry) => entry.phase === "after-reload" && matches(entry, context.urls),
  );
}

const tabAttach: ProbeDefinition = {
  id: "tab-attach",
  description: "attach({ tabId }) to the fixture page's tab",
  run: async (context) => {
    const { tabId } = context.state;
    if (tabId === undefined) return unavailable("getTargets() listed no tab for the fixture page");
    return attempt(async () => {
      await withTimeout(context.api.attach({ tabId }, PROTOCOL_VERSION), "attach");
      context.state.tabAttached = true;
      return { tabId };
    });
  },
};

const IFRAME_SCRIPT = (url: string) =>
  `document.body.append(Object.assign(document.createElement("iframe"), { src: ${JSON.stringify(url)} })); "appended"`;

async function reloadAndWatch(context: ProbeContext, tab: Debuggee): Promise<unknown> {
  const { urls, state } = context;
  await send(context, tab, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  state.autoAttachSet = true;
  await context.wait(AUTO_ATTACH_SETTLE_MS);
  state.autoAttachPhase = "after-reload";
  await send(context, tab, "Page.reload");
  const workers = () =>
    seen(context, byUrl("dedicatedWorkerUrl")) && seen(context, byUrl("sharedWorkerUrl"));
  await waitFor(context, workers, AUTO_ATTACH_WINDOW_MS);
  const expression = IFRAME_SCRIPT(urls.iframeUrl);
  await send(context, tab, "Runtime.evaluate", { expression, returnByValue: true });
  await waitFor(context, () => seen(context, isIframe), AUTO_ATTACH_WINDOW_MS);
  await context.wait(AUTO_ATTACH_SETTLE_MS);
  expectEffect(
    state.autoAttached.length > 0,
    `Target.setAutoAttach accepted but no Target.attachedToTarget within ${AUTO_ATTACH_WINDOW_MS} ms of the reload and the iframe`,
  );
  return state.autoAttached.map(({ type, url, waitingForDebugger, phase }) => ({
    type,
    url,
    waitingForDebugger,
    phase,
  }));
}

const autoAttach: ProbeDefinition = {
  id: "auto-attach",
  description:
    "Target.setAutoAttach({ autoAttach, waitForDebuggerOnStart, flatten }) on the tab, then a reload and a cross-site iframe; every Target.attachedToTarget",
  run: async (context) => {
    const tab = tabDebuggee(context);
    if (!tab) return unavailable("the tab is not attached");
    return attempt(() => reloadAndWatch(context, tab));
  },
};

function autoAttached(name: string, matches: Matcher): ProbeDefinition {
  return {
    id: `auto-attach-${name}`,
    description: `auto-attach reports the ${name} (Target.attachedToTarget)`,
    run: async (context) => {
      if (!context.state.autoAttachSet) return unavailable("auto-attach was not set");
      const entries = context.state.autoAttached.filter((entry) => matches(entry, context.urls));
      if (entries.length > 0) {
        const detail = entries.map(({ type, waitingForDebugger, phase }) => ({
          type,
          waitingForDebugger,
          phase,
        }));
        return { status: "allowed", detail };
      }
      return { status: "rejected", error: `no Target.attachedToTarget for the ${name}` };
    },
  };
}

const runIfWaiting: ProbeDefinition = {
  id: "run-if-waiting-for-debugger",
  description: "Runtime.runIfWaitingForDebugger releases every auto-attached target that waited",
  run: async (context) => {
    const waiting = context.state.autoAttached.filter((entry) => entry.waitingForDebugger);
    if (waiting.length === 0) return unavailable("no auto-attached target waited for the debugger");
    await waitFor(context, () => waiting.every((entry) => entry.released), AUTO_ATTACH_WINDOW_MS);
    const failed = waiting.find((entry) => entry.released !== "ok");
    const detail = waiting.map(({ type, released }) => ({ type, released }));
    if (failed) {
      const silent = `Runtime.runIfWaitingForDebugger got no reply for the ${failed.type} within ${AUTO_ATTACH_WINDOW_MS} ms`;
      return { status: "rejected", error: failed.released ?? silent, detail };
    }
    return { status: "allowed", detail };
  },
};

export const AUTO_ATTACH_PROBES: ProbeDefinition[] = [
  tabAttach,
  autoAttach,
  autoAttached("dedicated-worker", byUrl("dedicatedWorkerUrl")),
  autoAttached("shared-worker", byUrl("sharedWorkerUrl")),
  autoAttached("service-worker", byUrl("serviceWorkerUrl")),
  autoAttached("iframe", isIframe),
  runIfWaiting,
];

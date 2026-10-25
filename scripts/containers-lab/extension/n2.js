// Variant N2: chrome.debugger on each container tab. Fetch interception writes the exact Cookie
// header of every request. Fetch hides Set-Cookie from paused responses and Chrome stores it
// anyway, so the session rules strip it and the webRequest observer captures it (rules.js).
// Auto-attach adds the tab's out-of-process frames and workers, which have their own sessions.
import { record } from "./events.js";
import { jarOf, settled } from "./jar-store.js";
import { cookieHeader } from "./jar.js";
import { containerOf } from "./registry.js";

const attached = new Map();
const setups = [];
const WEB = /^(https?:|blob:|about:|data:)/;
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/** Extra commands for each tab session and child session, such as the page prelude (Layer 2). */
export const addSetup = (setup) => setups.push(setup);

const send = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params);

const COMMANDS = [
  ["Network.enable", {}],
  ["Network.setCacheDisabled", { cacheDisabled: true }],
  ["Network.setBypassServiceWorker", { bypass: true }],
  ["Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }],
  ["Target.setAutoAttach", AUTO_ATTACH],
];

/** Network, Fetch, and auto-attach for one session; a worker's lacks some of these domains. */
async function intercept(target) {
  for (const [method, params] of COMMANDS) {
    await send(target, method, params).catch((error) => {
      if (!String(error).includes("wasn't found")) throw error;
      record("n2-missing-domain", { method, worker: Boolean(target.targetId) });
    });
  }
}

const sharedWorkers = new Map();

/** The page reports a new shared worker before its target exists; its title is its name. */
async function sharedWorkerTarget(name) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await chrome.debugger.getTargets();
    const found = targets.find((target) => target.type === "worker" && target.title === name);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/**
 * A shared worker is no tab's child, so it is attached by target once a container's page creates
 * it. It already runs by then: what it does first is not intercepted. Fetch never pauses its
 * requests either, and extra headers do not reach them, so its network keeps Chrome's jar.
 */
export async function attachSharedWorker(container, name, url) {
  const target = await sharedWorkerTarget(name);
  if (!target) return record("n2-shared-missing", { name, url });
  // A second tab of the container reports the same worker.
  if (sharedWorkers.has(target.id)) return;
  const debuggee = { targetId: target.id };
  await chrome.debugger.attach(debuggee, "1.3");
  sharedWorkers.set(target.id, { container });
  for (const setup of setups) await setup(debuggee, container, "shared_worker");
  await intercept(debuggee);
  record("n2-shared-attached", { container, title: target.title });
}

async function attach(tabId, container) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3").catch((error) => {
    // This extension's session outlives its service worker, so a restarted worker adopts it.
    if (!String(error).includes("Another debugger is already attached")) throw error;
    record("n2-adopted", { tabId });
  });
  const { frameTree } = await send(target, "Page.getFrameTree");
  attached.set(tabId, { container, mainFrame: frameTree.frame.id });
  for (const setup of setups) await setup(target, container, "page");
  await intercept(target);
  record("n2-attached", { tabId, container });
}

async function detach(tabId) {
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

export const isAttached = (tabId) => attached.has(tabId);

/** Attaches to every assigned tab and detaches from the rest; `on` false detaches from all. */
export async function syncN2(assignments, on) {
  const wanted = on ? assignments : new Map();
  for (const tabId of attached.keys())
    if (wanted.get(tabId) !== attached.get(tabId)?.container) await detach(tabId);
  for (const [tabId, container] of wanted) {
    if (attached.has(tabId)) continue;
    await attach(tabId, container).catch((error) =>
      record("n2-attach-failed", { tabId, error: String(error) }),
    );
  }
}

async function onRequest(source, state, params) {
  const { request, resourceType, frameId } = params;
  const crossSite = request.isSameSite === false;
  const topLevelNavigation =
    !source.sessionId && resourceType === "Document" && frameId === state.mainFrame;
  const options = { now: Date.now(), crossSite, topLevelNavigation, method: request.method };
  await settled();
  const value = cookieHeader(await jarOf(state.container), request.url, options);
  const headers = Object.entries(request.headers)
    .filter(([name]) => name.toLowerCase() !== "cookie")
    .map(([name, headerValue]) => ({ name, value: headerValue }));
  // Always set it: with no Cookie header Chrome would attach its own jar's cookies.
  headers.push({ name: "Cookie", value });
  const type = source.targetId ? "n2-shared-request" : "n2-request";
  record(type, {
    tabId: source.tabId,
    child: Boolean(source.sessionId),
    url: request.url,
    cookie: value,
  });
  return send(source, "Fetch.continueRequest", { requestId: params.requestId, headers });
}

function onPaused(source, params) {
  if (source.targetId) return onRequest(source, sharedWorkers.get(source.targetId), params);
  const state = attached.get(source.tabId);
  if (!state || containerOf(source.tabId) !== state.container) {
    return send(source, "Fetch.continueRequest", { requestId: params.requestId });
  }
  return onRequest(source, state, params);
}

/** A child target waits for the debugger, so its first request is intercepted too. */
async function onChild(source, { sessionId, targetInfo }) {
  const child = { tabId: source.tabId, sessionId };
  try {
    // Auto-attach also reports this extension's own service worker, and the control's service
    // workers, which are off in containers (S1) and must not get a container's prelude.
    const web = WEB.test(targetInfo.url) && targetInfo.type !== "service_worker";
    const state = web ? attached.get(source.tabId) : undefined;
    if (state) await intercept(child);
    for (const setup of state ? setups : []) await setup(child, state.container, targetInfo.type);
    record("n2-child", { tabId: source.tabId, targetType: targetInfo.type, url: targetInfo.url });
  } finally {
    await send(child, "Runtime.runIfWaitingForDebugger").catch(() => {});
  }
}

const handlers = { "Fetch.requestPaused": onPaused, "Target.attachedToTarget": onChild };

/** `whenReady()` resolves once the tabs are classified: a restarted worker gets paused requests first. */
export function startN2(whenReady) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const handler = handlers[method];
    if (!handler || (source.tabId === undefined && !sharedWorkers.has(source.targetId))) return;
    const target = source.targetId
      ? { targetId: source.targetId }
      : source.sessionId
        ? { tabId: source.tabId, sessionId: source.sessionId }
        : { tabId: source.tabId };
    whenReady()
      .then(() => handler(target, params))
      .catch((error) => record("n2-event-failed", { method, error: String(error) }));
  });
  chrome.debugger.onDetach.addListener(({ tabId, targetId }, reason) => {
    if (tabId !== undefined) attached.delete(tabId);
    sharedWorkers.delete(targetId);
    record("n2-detached", { tabId, reason });
  });
}

// Which identity each document of a managed tab belongs to. A request is attributed to the document
// that made it, never to the tab's current identity: CDP's `loaderId` on the debugger side
// (Network.requestWillBeSent, Page.frameNavigated) and webNavigation's `documentId` on the
// webRequest side. A document that committed while no identity was active maps to null, and a
// request whose document is unknown is blocked.
import { record } from "./events.js";

const LIMIT = 64;
const WAIT_MS = 200;
const tabs = new Map();
/** @type {(tabId: number) => { managed: boolean, container: string | null }} */
let phaseOf = () => ({ managed: false, container: null });

function stateOf(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      loaders: new Map(),
      documents: new Map(),
      requests: new Map(),
      commitWaiters: new Set(),
      loaderWaiters: new Map(),
      committed: [],
    });
  }
  return tabs.get(tabId);
}

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value);
}

/** `phase(tabId)` tells whether a tab is managed and which container is active, or null. */
export const setPhaseSource = (phase) => (phaseOf = phase);

/** Resolves the neutral document's commit: `{ documentId, url }` from webNavigation. */
export function waitForCommit(tabId, matches, timeoutMs = 5000) {
  const state = stateOf(tabId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.commitWaiters.delete(waiter);
      reject(new Error(`No document committed in tab ${tabId} within ${timeoutMs} ms`));
    }, timeoutMs);
    const waiter = (details) => {
      if (!matches(details)) return;
      clearTimeout(timer);
      state.commitWaiters.delete(waiter);
      resolve(details);
    };
    state.commitWaiters.add(waiter);
  });
}

/** Commits of every tab a switch waits on (managed or swap): documents, evidence, and waiters. */
function onCommitted(details) {
  const { tabId, frameId, documentId, url } = details;
  if (!tabs.has(tabId)) return;
  const phase = phaseOf(tabId);
  const state = stateOf(tabId);
  remember(state.documents, documentId, phase.container);
  if (frameId === 0) {
    state.committed.push({ at: Date.now(), documentId, url, container: phase.container });
    if (state.committed.length > LIMIT) state.committed.shift();
  }
  record("document-committed", { tabId, frameId, documentId, url, container: phase.container });
  for (const waiter of state.commitWaiters) waiter(details);
}

function onRequestWillBeSent(state, tabId, params) {
  remember(state.requests, params.requestId, params.loaderId);
  if (params.type === "Document" && !state.loaders.has(params.loaderId))
    remember(state.loaders, params.loaderId, phaseOf(tabId).container);
  state.loaderWaiters.get(params.requestId)?.();
}

function onFrameNavigated(state, tabId, { frame }) {
  if (state.loaders.has(frame.loaderId)) return;
  remember(state.loaders, frame.loaderId, phaseOf(tabId).container);
  record("frame-navigated", { tabId, loaderId: frame.loaderId, url: frame.url });
}

const NETWORK_EVENTS = {
  "Network.requestWillBeSent": onRequestWillBeSent,
  "Network.loadingFinished": (state, tabId, params) => state.requests.delete(params.requestId),
  "Network.loadingFailed": (state, tabId, params) => state.requests.delete(params.requestId),
  "Page.frameNavigated": onFrameNavigated,
};

function onNetworkEvent(source, method, params) {
  const handler = NETWORK_EVENTS[method];
  if (!handler || source.sessionId !== undefined || !phaseOf(source.tabId).managed) return;
  handler(stateOf(source.tabId), source.tabId, params);
}

/** Waits briefly for Network.requestWillBeSent when Fetch paused a request first. */
function loaderOf(state, networkId) {
  const known = state.requests.get(networkId);
  if (known !== undefined || !networkId) return Promise.resolve(known);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.loaderWaiters.delete(networkId);
      resolve(undefined);
    }, WAIT_MS);
    state.loaderWaiters.set(networkId, () => {
      clearTimeout(timer);
      state.loaderWaiters.delete(networkId);
      record("request-waited-for-loader", { networkId });
      resolve(state.requests.get(networkId));
    });
  });
}

/**
 * The container a paused request belongs to: `{ container }`, or `{ block }` with the reason when
 * no identity can be determined safely. A child session (worker, frame) uses the container it was
 * bound to when it attached: the one of the document that created it.
 */
export async function decide(source, state, params) {
  const phase = phaseOf(source.tabId);
  if (!phase.managed) return { container: state.container };
  if (source.sessionId !== undefined) {
    return typeof state.childContainer === "string"
      ? { container: state.childContainer }
      : { block: "child-of-unknown-document" };
  }
  if (params.resourceType === "Document") {
    return phase.container === null
      ? { block: "navigation-while-switching" }
      : { container: phase.container };
  }
  const loaderId = await loaderOf(stateOf(source.tabId), params.networkId);
  const container =
    loaderId === undefined ? undefined : stateOf(source.tabId).loaders.get(loaderId);
  if (container === undefined) return { block: "unknown-document" };
  if (container === null) return { block: "document-of-no-identity" };
  return { container };
}

/** The container a response's Set-Cookie belongs to, or null to drop it. */
export function containerForResponse(details) {
  const phase = phaseOf(details.tabId);
  if (!phase.managed) return undefined;
  if (details.type === "main_frame" || details.type === "sub_frame") return phase.container;
  const known = stateOf(details.tabId).documents.get(details.documentId);
  return known === undefined ? null : known;
}

/** Main-frame commits of a managed tab, oldest first: the evidence that each switch made a document. */
export const commitsOf = (tabId) => [...stateOf(tabId).committed];

export function startDocuments() {
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== undefined) onNetworkEvent(source, method, params);
  });
  chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
}

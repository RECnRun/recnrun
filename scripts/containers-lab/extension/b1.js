// Bootstrap B1: the debugger registers the prelude with the container and its cookie snapshot
// before any document of the session starts, and registers it again when the jar changes.
// `runImmediately` also runs it in documents that already exist, where it only refreshes the
// snapshot. Workers get it by Runtime.evaluate while they wait for the debugger.
import { record } from "./events.js";
import { jarOf, onJarChanged, storeHeaders } from "./jar-store.js";
import { addSetup, attachSharedWorker } from "./n2.js";
import { BINDING, preludeSource } from "./prelude-source.js";
import { containerOf } from "./registry.js";

const WORKERS = new Set(["worker", "shared_worker", "service_worker"]);
const sessions = new Map();
let enabled = false;
let refreshing = Promise.resolve();

const keyOf = ({ tabId, sessionId }) => `${tabId}/${sessionId ?? ""}`;
const send = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params);

export const setB1 = (on) => {
  enabled = on;
};

async function installPrelude(target, container, type) {
  if (!enabled) return;
  await send(target, "Runtime.enable");
  await send(target, "Runtime.addBinding", { name: BINDING });
  const source = preludeSource(container, await jarOf(container));
  if (WORKERS.has(type)) {
    const { exceptionDetails } = await send(target, "Runtime.evaluate", { expression: source });
    record("b1-worker", {
      kind: type,
      exception: exceptionDetails?.exception?.description?.slice(0, 200),
    });
    return;
  }
  await send(target, "Page.enable");
  const { identifier } = await send(target, "Page.addScriptToEvaluateOnNewDocument", {
    source,
    runImmediately: true,
  });
  sessions.set(keyOf(target), { target, container, identifier });
}

/** Adds the new script before removing the old one, so no document starts without a prelude. */
async function reinstall(key, session, source) {
  const add = (runImmediately) =>
    send(session.target, "Page.addScriptToEvaluateOnNewDocument", { source, runImmediately });
  try {
    const { identifier } = await add(true).catch((error) => {
      record("b1-refresh-retry", { error: String(error) });
      return add(false);
    });
    await send(session.target, "Page.removeScriptToEvaluateOnNewDocument", {
      identifier: session.identifier,
    });
    session.identifier = identifier;
  } catch (error) {
    record("b1-refresh-failed", { error: String(error) });
    sessions.delete(key);
  }
}

/** Re-registers the prelude of a tab's main session for another container (sessions.js switches). */
export async function switchPrelude(tabId, container) {
  const key = keyOf({ tabId });
  const session = sessions.get(key);
  if (!session) throw new Error(`Tab ${tabId} has no prelude session to switch`);
  session.container = container;
  await reinstall(key, session, preludeSource(container, await jarOf(container)));
  if (!sessions.has(key)) throw new Error(`The prelude for tab ${tabId} could not be reinstalled`);
}

async function jarChanged(container) {
  const source = preludeSource(container, await jarOf(container));
  for (const [key, session] of sessions)
    if (session.container === container) await reinstall(key, session, source);
}

function onBinding(source, params) {
  const container = containerOf(source.tabId);
  if (params.name !== BINDING || !container) return;
  const message = JSON.parse(params.payload);
  if (message.type === "shared-worker") {
    void attachSharedWorker(container, message.name, message.url).catch((error) =>
      record("n2-shared-failed", { error: String(error) }),
    );
  }
  if (message.type !== "cookie") return;
  record("script-cookie", { tabId: source.tabId, header: message.header });
  void storeHeaders(container, [message.header], message.url, { fromScript: true });
}

export function startB1() {
  addSetup(installPrelude);
  // Not awaited: a navigation's next request waits for the jar, and runImmediately waits for it.
  onJarChanged((container) => {
    refreshing = refreshing
      .then(() => jarChanged(container))
      .catch((error) => record("b1-failed", { error: String(error) }));
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === "Runtime.bindingCalled") onBinding(source, params);
    if (method === "Target.detachedFromTarget")
      sessions.delete(keyOf({ tabId: source.tabId, sessionId: params.sessionId }));
  });
  chrome.debugger.onDetach.addListener(({ tabId }) => {
    for (const key of sessions.keys()) if (key.startsWith(`${tabId}/`)) sessions.delete(key);
  });
}

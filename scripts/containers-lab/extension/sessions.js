// The single-tab session manager: several identities take turns in one tab, one active at a time.
// An identity is a container (jar and storage namespace) that survives while it is suspended; a
// reset gives it a new, empty container. Every switch destroys the tab's document through a
// neutral about:blank, rebinds the debugger session, the registry, and the prelude to the next
// container, and only then loads the application again. Switches run one at a time, and a failed
// switch leaves the tab blocked until a switch succeeds. A tab runs in one of two modes: "debugger"
// (the default: one jar per identity on the network path, as the tab-group lab does) or "swap"
// (no debugger: the profile's cookie store is saved and restored around the switch, swap.js, once
// the tab's requests have drained or an idle timeout passed, network-idle.js).
import { switchPrelude } from "./b1.js";
import { setPhaseSource, waitForCommit } from "./documents.js";
import { record } from "./events.js";
import { clearJar } from "./jar-store.js";
import { detachTab, isAttached, rebind } from "./n2.js";
import { waitForIdle } from "./network-idle.js";
import { pin, refresh } from "./registry.js";
import { blockTab, unblockTab } from "./sessions-block.js";
import { PROFILE_JAR, empty, restore, save } from "./swap.js";

const NEUTRAL = "about:blank";
const identities = new Map();
const tabs = new Map();
let queue = Promise.resolve();
let fault;

/** The container name of an identity's generation: the first keeps the id, a reset appends it. */
export const containerIdOf = (id, generation) =>
  generation === 1 ? id.toLowerCase() : `${id.toLowerCase()}.${generation}`;

/**
 * The tab's state; its mode is fixed by the first activation and later calls may omit it. In the
 * swap mode `store` names the jar whose cookies Chrome's store holds in full (the profile's own at
 * first), or null while the store holds nothing worth saving: leftovers, or a partial restore.
 */
function tabOf(tabId, mode = "debugger") {
  if (!tabs.has(tabId)) {
    const store = mode === "swap" ? PROFILE_JAR : null;
    tabs.set(tabId, { identity: null, phase: "idle", mode, store, switches: [] });
  }
  const tab = tabs.get(tabId);
  if (tab.mode !== mode) throw new Error(`Tab ${tabId} runs in mode ${tab.mode}, not ${mode}`);
  return tab;
}

/**
 * The identity's current container, created on first use; `reset` abandons the previous one, whose
 * jar is cleared once the switch is done (the swap mode saves the store into it first).
 */
function identityOf(id, reset) {
  const existing = identities.get(id);
  if (existing && !reset) return { identity: existing, kind: "resume" };
  const generation = (existing?.generation ?? 0) + 1;
  const identity = { id, generation, container: containerIdOf(id, generation), lastUrl: undefined };
  identities.set(id, identity);
  return { identity, kind: existing ? "reset" : "start", abandoned: existing?.container };
}

async function suspend(tab, tabId) {
  const previous = tab.phase === "active" ? identities.get(tab.identity) : undefined;
  if (!previous) return;
  previous.lastUrl = (await chrome.tabs.get(tabId)).url;
  record("identity-suspended", { tabId, identity: previous.id, lastUrl: previous.lastUrl });
}

/** Loads the neutral document and resolves once it committed: the previous document is gone. */
async function neutralize(tabId) {
  const committed = waitForCommit(tabId, ({ frameId, url }) => frameId === 0 && url === NEUTRAL);
  await chrome.tabs.update(tabId, { url: NEUTRAL });
  return committed;
}

/**
 * Saves the store once the old document's requests are done (within `idleTimeoutMs`), then empties
 * it. The jar is the snapshot as soon as it is saved: a failure while emptying leaves leftovers
 * that the next switch removes without saving them over the jar.
 */
async function settle(tabId, tab, idleTimeoutMs) {
  const settled = await waitForIdle(tabId, idleTimeoutMs);
  record("network-settled", { tabId, ...settled });
  if (tab.store !== null) {
    record("cookies-saved", { tabId, jar: tab.store, saved: await save(tab.store) });
    tab.store = null;
  }
  if (fault === "empty") {
    fault = undefined;
    await empty(1);
    throw new Error("Injected failure: the store could not be emptied");
  }
  record("cookies-removed", { tabId, removed: await empty() });
}

/** Writes `container`'s cookies into the store; the prelude reads the identity cookie from it. */
async function bindSwap(tabId, container) {
  const restored = await restore(container);
  // Only a complete restore makes the store worth saving back into the jar.
  tabs.get(tabId).store = container;
  record("cookies-restored", { tabId, container, restored });
  if (fault === "reconfigure") {
    fault = undefined;
    throw new Error("Injected failure: the identity cookie could not be written");
  }
}

/** Binds the debugger session, the registry, and the prelude to `container` before any app document. */
async function bind(tabId, container) {
  if (fault === "detach") {
    fault = undefined;
    await detachTab(tabId);
  }
  const wasAttached = isAttached(tabId);
  if (wasAttached) rebind(tabId, container);
  pin(tabId, container);
  await refresh();
  if (!isAttached(tabId)) throw new Error(`The debugger does not hold tab ${tabId}`);
  if (fault === "reconfigure") {
    fault = undefined;
    throw new Error("Injected failure: the prelude could not be reconfigured");
  }
  if (wasAttached) await switchPrelude(tabId, container);
}

async function navigate(tabId, url) {
  const committed = waitForCommit(
    tabId,
    ({ frameId, url: committedUrl }) => frameId === 0 && committedUrl !== NEUTRAL,
    15000,
  );
  await chrome.tabs.update(tabId, { url });
  return committed;
}

async function transition(tabId, tab, identity, { url, idleTimeoutMs }) {
  const neutral = await neutralize(tabId);
  if (tab.mode === "swap") await settle(tabId, tab, idleTimeoutMs);
  await (tab.mode === "swap" ? bindSwap : bind)(tabId, identity.container);
  tab.identity = identity.id;
  tab.phase = "active";
  await unblockTab(tabId);
  const document = await navigate(tabId, url);
  return { neutral, document };
}

async function attempt(tab, identity, target, receipt) {
  const { tabId } = receipt;
  try {
    Object.assign(receipt, await transition(tabId, tab, identity, target));
    if (receipt.abandoned) await clearJar(receipt.abandoned);
  } catch (error) {
    tab.phase = "failed";
    await blockTab(tabId);
    record("switch-failed", { ...receipt, error: String(error) });
    throw error;
  }
}

async function doActivate(tabId, id, { reset = false, url, mode, idleTimeoutMs } = {}) {
  const tab = tabOf(tabId, mode ?? tabs.get(tabId)?.mode);
  const target = url ?? identities.get(id)?.lastUrl;
  if (!target) throw new Error(`Identity ${id} has no URL to open; pass one`);
  const started = Date.now();
  await suspend(tab, tabId);
  const { identity, kind, abandoned } = identityOf(id, reset);
  const receipt = { tabId, from: tab.identity, to: id, kind, container: identity.container };
  if (abandoned) receipt.abandoned = abandoned;
  tab.phase = "switching";
  record("switch-started", receipt);
  await attempt(tab, identity, { url: target, idleTimeoutMs }, receipt);
  receipt.ms = Date.now() - started;
  tab.switches.push(receipt);
  record("switch-done", receipt);
  return receipt;
}

/**
 * Makes `id` the tab's active identity: a start, a resume, or (with `reset`) a fresh container.
 * `mode` is "debugger" or "swap" and is fixed by the tab's first activation; `idleTimeoutMs` bounds
 * how long the swap mode waits for the previous document's requests.
 */
export function activate(tabId, id, options) {
  const run = queue.then(() => doActivate(tabId, id, options));
  queue = run.catch(() => {});
  return run;
}

/** The next switch fails at `kind`: "detach" loses the debugger session, "reconfigure" the prelude. */
export const failNext = (kind) => {
  fault = kind;
};

export const isManaged = (tabId) => tabs.has(tabId);

export const sessions = () => ({
  identities: [...identities.values()],
  tabs: [...tabs].map(([tabId, tab]) => ({ tabId, ...tab })),
});

export function startSessions() {
  setPhaseSource((tabId) => {
    const tab = tabs.get(tabId);
    // A swap tab is a control tab to the network engines: Chrome's store is the active identity's.
    if (!tab || tab.mode === "swap") return { managed: false, container: null };
    const active = tab.phase === "active" ? identities.get(tab.identity) : undefined;
    return { managed: true, container: active?.container ?? null };
  });
  // The browser (or the user, through the infobar) ended the session: the tab has no identity.
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    const tab = tabId === undefined ? undefined : tabs.get(tabId);
    if (!tab || tab.phase !== "active") return;
    tab.phase = "failed";
    record("session-lost", { tabId, reason });
    void blockTab(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
}

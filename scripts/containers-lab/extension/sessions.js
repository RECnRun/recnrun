// The single-tab session manager: several identities take turns in one tab, one active at a time.
// An identity is a container (jar and storage namespace) that survives while it is suspended; a
// reset gives it a new, empty container. Every switch destroys the tab's document through a
// neutral about:blank, rebinds the debugger session, the registry, and the prelude to the next
// container, and only then loads the application again. Switches run one at a time, and a failed
// switch leaves the tab blocked until a switch succeeds. A tab runs in one of two modes: "debugger"
// (the default: one jar per identity on the network path, as the tab-group lab does) or "swap"
// (no debugger: the profile's cookie store is saved and restored around the switch, swap.js).
import { switchPrelude } from "./b1.js";
import { setPhaseSource, waitForCommit } from "./documents.js";
import { record } from "./events.js";
import { clearJar } from "./jar-store.js";
import { detachTab, isAttached, rebind } from "./n2.js";
import { pin, refresh } from "./registry.js";
import { blockTab, unblockTab } from "./sessions-block.js";
import { PROFILE_JAR, restore, stash } from "./swap.js";

const NEUTRAL = "about:blank";
const identities = new Map();
const tabs = new Map();
let queue = Promise.resolve();
let fault;

/** The container name of an identity's generation: the first keeps the id, a reset appends it. */
export const containerIdOf = (id, generation) =>
  generation === 1 ? id.toLowerCase() : `${id.toLowerCase()}.${generation}`;

/** The tab's state; its mode is fixed by the first activation and later calls may omit it. */
function tabOf(tabId, mode = "debugger") {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, { identity: null, phase: "idle", mode, store: null, switches: [] });
  }
  const tab = tabs.get(tabId);
  if (tab.mode !== mode) throw new Error(`Tab ${tabId} runs in mode ${tab.mode}, not ${mode}`);
  return tab;
}

/** The identity's current container, created on first use; `reset` abandons the previous one. */
function identityOf(id, reset) {
  const existing = identities.get(id);
  if (existing && !reset) return { identity: existing, kind: "resume" };
  const generation = (existing?.generation ?? 0) + 1;
  const identity = { id, generation, container: containerIdOf(id, generation), lastUrl: undefined };
  identities.set(id, identity);
  if (existing) void clearJar(existing.container);
  return { identity, kind: existing ? "reset" : "start" };
}

async function suspend(tab, tabId) {
  const previous = tab.phase === "active" ? identities.get(tab.identity) : undefined;
  if (tab.mode === "swap") {
    // The store holds the cookies of the jar last written into it (a failed switch included), or the
    // profile's own before the first switch.
    const jar = tab.store ?? PROFILE_JAR;
    record("cookies-stashed", { tabId, jar, saved: await stash(jar) });
    tab.store = null;
  }
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

/** Writes `container`'s cookies into the store; the prelude reads the identity cookie from it. */
async function bindSwap(tabId, container) {
  tabs.get(tabId).store = container;
  const restored = await restore(container);
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

async function transition(tabId, tab, identity, url) {
  const neutral = await neutralize(tabId);
  await (tab.mode === "swap" ? bindSwap : bind)(tabId, identity.container);
  tab.identity = identity.id;
  tab.phase = "active";
  await unblockTab(tabId);
  const document = await navigate(tabId, url);
  return { neutral, document };
}

async function attempt(tab, identity, url, receipt) {
  const { tabId } = receipt;
  try {
    Object.assign(receipt, await transition(tabId, tab, identity, url));
  } catch (error) {
    tab.phase = "failed";
    await blockTab(tabId);
    record("switch-failed", { ...receipt, error: String(error) });
    throw error;
  }
}

async function doActivate(tabId, id, { reset = false, url, mode } = {}) {
  const tab = tabOf(tabId, mode ?? tabs.get(tabId)?.mode);
  const target = url ?? identities.get(id)?.lastUrl;
  if (!target) throw new Error(`Identity ${id} has no URL to open; pass one`);
  const started = Date.now();
  await suspend(tab, tabId);
  const { identity, kind } = identityOf(id, reset);
  const receipt = { tabId, from: tab.identity, to: id, kind, container: identity.container };
  tab.phase = "switching";
  record("switch-started", receipt);
  await attempt(tab, identity, target, receipt);
  receipt.ms = Date.now() - started;
  tab.switches.push(receipt);
  record("switch-done", receipt);
  return receipt;
}

/**
 * Makes `id` the tab's active identity: a start, a resume, or (with `reset`) a fresh container.
 * `mode` is "debugger" or "swap" and is fixed by the tab's first activation.
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

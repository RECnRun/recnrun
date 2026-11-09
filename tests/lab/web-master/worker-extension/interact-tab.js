// W7 slice B: the worker's own interactive tab: opened, attached, watched, and closed by it alone.
import { allows } from "./allow.js";
import { MODES, bind, unbind } from "./capture.js";
import { within } from "./interact-gate.js";
import { createHeld } from "./interact-held.js";
import { detachReason } from "./interact-lease.js";
import { originOf } from "./job-schema.js";
import { interactQuality } from "./quality.js";
import { dropTab, holdTab } from "./runner.js";
import { viewport } from "./viewport.js";

const KEY = "interactTab";
const DISPATCH_MS = 1_000;
const OP_MS = 2_000;
/** @type {any} */
let tab = null;
/** @type {{ offPolicy?: (url: string) => void, gone?: (reason: string) => void }} */
let watcher = {};
// The input command last sent: cleanup lets go only after it has answered or timed out.
let inflight = Promise.resolve();
const stats = { opened: 0, closed: 0, openersClosed: 0, leftoversClosed: 0, refreshes: 0 };
// Slice C: releases sent, by why (DEADMAN, CLEANUP), and those that failed.
Object.assign(stats, { released: {}, releaseEvents: 0, releaseFailed: 0 });
// W7 fixes: closes not confirmed, cleanups whose pressed state was unknown, late tabs closed.
Object.assign(stats, { closeFailed: 0, releaseUnknown: 0, lateTabsClosed: 0 });
const held = createHeld();

const command = (target, method, params = {}) =>
  chrome.debugger.sendCommand(target, method, params);
const allowed = (current, url) => allows(current.origins, originOf(url));

// A tab, debugger, or storage call that hangs fails by its deadline, named by its step.
const op = (name, work) =>
  within(work, OP_MS, "TIMEOUT").catch((error) => {
    throw new Error(`${name}: ${String(error?.message ?? error)}`);
  });
/** Rejects with INPUT_UNKNOWN when `work` has not answered by the deadline. */
const deadline = (work) => within(work, DISPATCH_MS, "INPUT_UNKNOWN");

/** False only when the tab is gone; a lookup that hangs counts as open. */
export const isOpen = (tabId) =>
  op("get", chrome.tabs.get(tabId)).then(
    () => true,
    (error) => String(error.message).endsWith("TIMEOUT"),
  );
// Closed is what the browser confirms: a refused remove counts only once the tab is gone.
const removed = (tabId) =>
  op("remove", chrome.tabs.remove(tabId)).then(
    () => true,
    async () => !(await isOpen(tabId)),
  );

/** Closes the tab a service worker that died had marked; false while it may still be open. */
export const recover = async () => {
  const { [KEY]: tabId } = await op("marker", chrome.storage.session.get(KEY));
  if (typeof tabId !== "number") return true;
  if (!(await removed(tabId))) return false;
  stats.leftoversClosed += 1;
  await op("unmark", chrome.storage.session.remove(KEY));
  return true;
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!tab || source.tabId !== tab.target.tabId || method !== "Page.frameNavigated") return;
  if (params.frame.parentId) return;
  tab.loaderId = params.frame.loaderId;
  tab.url = params.frame.url;
  // The request that led here has already left: the revoke follows the commit.
  if (tab.url !== "about:blank" && !allowed(tab, tab.url)) watcher.offPolicy?.(tab.url);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (tab && source.tabId === tab.target.tabId) watcher.gone?.(detachReason(reason));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tab?.target.tabId === tabId) watcher.gone?.("TAB_CLOSED");
});
// A tab's openerTabId names the window's active tab, not the background tab that opened it.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  if (!tab || sourceTabId !== tab.target.tabId) return;
  stats.openersClosed += 1;
  void chrome.tabs.remove(tabId).catch(() => false);
});

const prepare = async (tabId, target) => {
  await op("mark", chrome.storage.session.set({ [KEY]: tabId }));
  await op("attach", chrome.debugger.attach(target, "1.3"));
  await op("enable", command(target, "Page.enable"));
  // The zoom calls refuse a tab whose first document has not committed yet.
  await op("blank", command(target, "Page.navigate", { url: "about:blank" }));
  // Pinned at 100% for this tab alone: the mapping asserts it before each event.
  const settings = { mode: "automatic", scope: "per-tab" };
  await op("setZoomSettings", chrome.tabs.setZoomSettings(tabId, settings));
  await op("setZoom", chrome.tabs.setZoom(tabId, 1));
  // A background tab is hidden and draws no frames without it.
  const focus = { enabled: true };
  await op("focus", command(target, "Emulation.setFocusEmulationEnabled", focus));
};

// A tab created after its deadline belongs to no one: it is closed when it appears.
const create = () => {
  const creating = chrome.tabs.create({ url: "about:blank", active: false });
  return op("create", creating).catch((error) => {
    void creating
      .then((late) => {
        stats.lateTabsClosed += 1;
        return chrome.tabs.remove(late.id);
      })
      .catch(() => false);
    throw error;
  });
};

/** Opens the claimed interaction's tab at `url`; `on` hears an off-policy commit or a lost tab. */
export const openTab = async ({ interactId, url, origins }, on) => {
  const created = await create();
  const target = { tabId: created.id };
  tab = { interactId, target, origins, loaderId: null, url: "about:blank" };
  held.clear();
  watcher = on;
  stats.opened += 1;
  await prepare(created.id, target);
  holdTab(interactId, created.id, origins);
  bind(target, interactId);
  await op("navigate", command(target, "Page.navigate", { url }));
  return created.id;
};

/**
 * Lets go, detaches, and closes the tab: true once the browser confirms it is gone. Until then
 * the tab, its marker, and the claim stay, and a later call tries again.
 */
export const closeTab = async () => {
  if (!tab) return true;
  const current = tab;
  current.closing = true;
  await inflight;
  if (!current.released) {
    // Held buttons and keys are let go while the debugger still holds the tab.
    current.released = true;
    if (!(await releaseHeld("CLEANUP"))) stats.releaseUnknown += 1;
  }
  watcher = {};
  unbind(current.target);
  await op("detach", chrome.debugger.detach(current.target)).catch(() => false);
  if (!(await removed(current.target.tabId))) {
    stats.closeFailed += 1;
    return false;
  }
  tab = null;
  stats.closed += 1;
  dropTab(current.target.tabId);
  await op("unmark", chrome.storage.session.remove(KEY)).catch(() => false);
  return true;
};

// The view's size and pinch scale, read in a world of the worker's own that the page cannot patch.
const LAYOUT = "[innerWidth, innerHeight, visualViewport.scale]";
const worldOf = async (current) => {
  if (current.world?.loaderId === current.loaderId) return current.world.contextId;
  const { frameTree } = await deadline(command(current.target, "Page.getFrameTree"));
  const params = { frameId: frameTree.frame.id, worldName: "recnrun-layout" };
  const created = await deadline(command(current.target, "Page.createIsolatedWorld", params));
  current.world = { loaderId: frameTree.frame.loaderId, contextId: created.executionContextId };
  return created.executionContextId;
};
/** The layout now, or null when it cannot be read (a document that went away mid-read). */
const layoutOf = async (current) => {
  const contextId = await worldOf(current);
  const params = { expression: LAYOUT, contextId, returnByValue: true };
  const read = await deadline(command(current.target, "Runtime.evaluate", params));
  const [width, height, scale] = read.result?.value ?? [];
  return Number.isFinite(width) ? { width, height, scale } : null;
};

/** The document now, or null once the tab is closing; `fresh` re-reads the main frame's loader. */
export const liveDocument = async (fresh) => {
  const current = tab;
  if (!current || current.closing) return null;
  if (fresh) {
    const { frameTree } = await deadline(command(current.target, "Page.getFrameTree"));
    current.loaderId = frameTree.frame.loaderId;
    current.url = frameTree.frame.url;
  }
  const zoom = await deadline(chrome.tabs.getZoom(current.target.tabId));
  const layout = await layoutOf(current).catch(() => null);
  const { loaderId, url } = current;
  return { loaderId, url, zoom, layout, allowed: allowed(current, url) };
};

/** One input command with a deadline, tracked first: one that times out may still have pressed. */
const tracked = (method, params) => {
  held.track(method, params);
  return sent(method, params);
};
const sent = (method, params) => {
  const answer = deadline(command(tab.target, method, params));
  inflight = answer.catch(() => false);
  return answer;
};

export const mouse = (params) => tracked("Input.dispatchMouseEvent", params);
export const key = (params) => tracked("Input.dispatchKeyEvent", params);
export const insertText = (text) => sent("Input.insertText", { text });
export const holding = () => held.any();

/** Cancels any drag, then lets go of every held key and button; false when that is not certain. */
export const releaseHeld = async (reason) => {
  const current = tab;
  if (!current) return true;
  const before = held.size();
  const send = (method, params) => deadline(command(current.target, method, params));
  const sure = await held.releaseAll(send);
  if (before > 0) stats.released[reason] = (stats.released[reason] ?? 0) + 1;
  stats.releaseEvents += before - held.size();
  if (!sure) stats.releaseFailed += 1;
  return sure;
};

const restart = async (size) => {
  const params = { format: "jpeg", quality: interactQuality.value(), ...size };
  await op("stopScreencast", command(tab.target, "Page.stopScreencast"));
  await op("startScreencast", command(tab.target, "Page.startScreencast", params));
};

// A restarted screencast draws a fresh frame of an unchanged page; no screenshot is taken.
export const refresh = async () => {
  if (!tab || tab.closing) return;
  stats.refreshes += 1;
  await restart(viewport.size("interact", MODES.interact));
};

/** Sizes the view at device scale 1; a running screencast restarts at that size. False if gone. */
export const fitView = async ({ width, height }, observed) => {
  if (!tab || tab.closing) return false;
  const metrics = { width, height, deviceScaleFactor: 1, mobile: false };
  const method = "Emulation.setDeviceMetricsOverride";
  await op("setDeviceMetricsOverride", command(tab.target, method, metrics));
  if (observed) await restart({ maxWidth: width, maxHeight: height });
  return true;
};

export const tabState = () => ({
  tab: tab && { tabId: tab.target.tabId, loaderId: tab.loaderId, url: tab.url },
  held: held.size(),
  stats,
});

/** Lab only: resizes the tab's view, so a frame from before it is aimed at a stale viewport. */
export const resize = (width, height) =>
  width
    ? command(tab.target, "Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    : command(tab.target, "Emulation.clearDeviceMetricsOverride");

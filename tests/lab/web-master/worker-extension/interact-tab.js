// W7 slice B: the worker's own interactive tab: opened, attached, watched, and closed by it alone.
import { MODES, bind, unbind } from "./capture.js";
import { originOf } from "./job-schema.js";
import { dropTab, holdTab } from "./runner.js";

const KEY = "interactTab";
const DISPATCH_MS = 1_000;
const QUALITY = 50;
/** @type {any} */
let tab = null;
/** @type {{ offPolicy?: (url: string) => void, gone?: (reason: string) => void }} */
let watcher = {};
const stats = { opened: 0, closed: 0, openersClosed: 0, leftoversClosed: 0, refreshes: 0 };

const command = (method, params = {}) => chrome.debugger.sendCommand(tab.target, method, params);
const allowed = (url) => tab.origins.includes(originOf(url));

/** Rejects with INPUT_UNKNOWN when `work` has not answered by the deadline. */
const deadline = (work) =>
  Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error("INPUT_UNKNOWN")), DISPATCH_MS)),
  ]);

// A tab marked by a service worker that died is closed at the next startup.
const leftover = (async () => {
  const { [KEY]: tabId } = await chrome.storage.session.get(KEY);
  if (typeof tabId !== "number") return;
  stats.leftoversClosed += 1;
  await chrome.tabs.remove(tabId).catch(() => false);
  await chrome.storage.session.remove(KEY);
})().catch(() => false);

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!tab || source.tabId !== tab.target.tabId || method !== "Page.frameNavigated") return;
  if (params.frame.parentId) return;
  tab.loaderId = params.frame.loaderId;
  tab.url = params.frame.url;
  // The request that led here has already left: the revoke follows the commit.
  if (tab.url !== "about:blank" && !allowed(tab.url)) watcher.offPolicy?.(tab.url);
});
chrome.debugger.onDetach.addListener((source) => {
  if (tab && source.tabId === tab.target.tabId) watcher.gone?.("CDP_DETACHED");
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

// A failed step names itself, so a TAB_FAILED says which call refused.
const step = (name, work) =>
  work.catch((error) => {
    throw new Error(`${name}: ${String(error?.message ?? error)}`);
  });

const prepare = async (tabId, target) => {
  await chrome.storage.session.set({ [KEY]: tabId });
  await step("attach", chrome.debugger.attach(target, "1.3"));
  await command("Page.enable");
  // The zoom calls refuse a tab whose first document has not committed yet.
  await step("blank", command("Page.navigate", { url: "about:blank" }));
  // Pinned at 100% for this tab alone: the mapping asserts it before each event.
  const settings = { mode: "automatic", scope: "per-tab" };
  await step("setZoomSettings", chrome.tabs.setZoomSettings(tabId, settings));
  await step("setZoom", chrome.tabs.setZoom(tabId, 1));
  // A background tab is hidden and draws no frames without it.
  await command("Emulation.setFocusEmulationEnabled", { enabled: true });
};

/** Opens the claimed interaction's tab at `url`; `on` hears an off-policy commit or a lost tab. */
export const openTab = async ({ interactId, url, origins }, on) => {
  await leftover;
  const created = await chrome.tabs.create({ url: "about:blank", active: false });
  const target = { tabId: created.id };
  tab = { interactId, target, origins, loaderId: null, url: "about:blank" };
  watcher = on;
  stats.opened += 1;
  await prepare(created.id, target);
  holdTab(interactId, created.id, origins);
  bind(target, interactId);
  await command("Page.navigate", { url });
  return created.id;
};

/** Detaches and closes the tab; the claim is released only after this. */
export const closeTab = async () => {
  if (!tab) return;
  const { target } = tab;
  tab = null;
  watcher = {};
  stats.closed += 1;
  // Slice C releases held buttons and keys here, before the detach.
  dropTab(target.tabId);
  unbind(target);
  await chrome.debugger.detach(target).catch(() => false);
  await chrome.tabs.remove(target.tabId).catch(() => false);
  await chrome.storage.session.remove(KEY);
};

/** The document now; `fresh` re-reads the main frame's loader from the tab itself. */
export const liveDocument = async (fresh) => {
  if (fresh) {
    const { frameTree } = await deadline(command("Page.getFrameTree"));
    tab.loaderId = frameTree.frame.loaderId;
    tab.url = frameTree.frame.url;
  }
  const zoom = await chrome.tabs.getZoom(tab.target.tabId);
  return { loaderId: tab.loaderId, url: tab.url, zoom, allowed: allowed(tab.url) };
};

/** One mouse event with a deadline; a timeout leaves its effect unknown. */
export const mouse = (params) => deadline(command("Input.dispatchMouseEvent", params));

// A restarted screencast draws a fresh frame of an unchanged page; no screenshot is taken.
export const refresh = async () => {
  stats.refreshes += 1;
  await command("Page.stopScreencast");
  await command("Page.startScreencast", { format: "jpeg", quality: QUALITY, ...MODES.interact });
};

export const tabState = () => ({
  tab: tab && { tabId: tab.target.tabId, loaderId: tab.loaderId, url: tab.url },
  stats,
});

/** Lab only: resizes the tab's view, so a frame from before it is aimed at a stale viewport. */
export const resize = (width, height) =>
  width
    ? command("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    : command("Emulation.clearDeviceMetricsOverride");

export const isOpen = (tabId) =>
  chrome.tabs.get(tabId).then(
    () => true,
    () => false,
  );

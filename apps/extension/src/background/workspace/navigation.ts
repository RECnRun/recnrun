import { browser } from "wxt/browser";
import { isExpectedAgent } from "@/background/workspace/agent-link";
import { WorkspaceError } from "@/background/workspace/errors";
import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { OriginPort } from "@/messaging/origin-protocol";

interface ChromeEvent<A extends unknown[]> {
  addListener: (listener: (...args: A) => void) => void;
  removeListener: (listener: (...args: A) => void) => void;
}

interface Commit {
  tabId: number;
  frameId: number;
  url: string;
  documentId?: string;
}

interface NavigationError {
  tabId: number;
  frameId: number;
  error: string;
}

/** The tab and navigation calls the bootstrap needs; fakeBrowser lacks webNavigation events. */
export interface NavigationApi {
  update: (tabId: number, url: string) => Promise<void>;
  /** Reloads `documentId` from inside it, so the request is the page's own. */
  reload: (tabId: number, documentId: string) => Promise<void>;
  onCommitted: ChromeEvent<[Commit]>;
  onErrorOccurred: ChromeEvent<[NavigationError]>;
  onTabRemoved: ChromeEvent<[number]>;
  onConnect: ChromeEvent<[OriginPort]>;
}

interface Settle<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface TabListeners {
  onCommit: (commit: Commit) => void;
  onConnect?: (port: OriginPort) => void;
  /** Runs once the watch ends, however it ends. */
  onEnd?: () => void;
}

interface TabWatch {
  tabId: number;
  boundMs: number;
  late: () => WorkspaceError;
  start: () => Promise<void>;
}

const sameOrigin = (url: string, origin: string) => URL.parse(url)?.origin === origin;

const offOrigin = () =>
  new WorkspaceError("OffOriginNavigation", "The page left the target site before it loaded.");

const isWeb = (url: string) => /^https?:$/.test(URL.parse(url)?.protocol ?? "");

const offWeb = () =>
  new WorkspaceError("OffOriginNavigation", "The page left the web before it loaded.");

/**
 * Follows one tab's top-frame navigation from listeners registered before `start`, so no event goes
 * unseen, until the listeners settle it, the navigation fails, the tab closes, or the bound passes.
 */
function watchTab<T>(
  api: NavigationApi,
  watch: TabWatch,
  listen: (settle: Settle<T>) => TabListeners,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let open = true;
    const end = (finish: () => void) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      api.onCommitted.removeListener(onCommitted);
      api.onErrorOccurred.removeListener(onError);
      api.onTabRemoved.removeListener(onRemoved);
      if (onConnect) api.onConnect.removeListener(onConnect);
      onEnd?.();
      finish();
    };
    const settle: Settle<T> = {
      resolve: (value) => end(() => resolve(value)),
      reject: (error) => end(() => reject(error)),
    };
    const { onCommit, onConnect, onEnd } = listen(settle);
    const top = (details: { tabId: number; frameId: number }) =>
      details.tabId === watch.tabId && details.frameId === 0;
    // The neutral window's about:blank may commit late; it is never the target.
    const onCommitted = (commit: Commit) => {
      if (top(commit) && commit.url !== "about:blank") onCommit(commit);
    };
    const onError = (details: NavigationError) => {
      if (!top(details)) return;
      const message = `The page did not load (${details.error}).`;
      settle.reject(new WorkspaceError("NavigationFailed", message));
    };
    const closed = () =>
      new WorkspaceError("TabClosed", "The Incognito page closed before it was ready.");
    const onRemoved = (tabId: number) => {
      if (tabId === watch.tabId) settle.reject(closed());
    };
    const timer = setTimeout(() => settle.reject(watch.late()), watch.boundMs);
    api.onCommitted.addListener(onCommitted);
    api.onErrorOccurred.addListener(onError);
    api.onTabRemoved.addListener(onRemoved);
    if (onConnect) api.onConnect.addListener(onConnect);
    // Chrome rejects a tab id it no longer knows.
    watch.start().catch(() => settle.reject(closed()));
  });
}

interface Target {
  tabId: number;
  url: string;
  origin: string;
}

/** How many links each tab's open watches follow: a link from a tab none follows is stray. */
const followed = new Map<number, number>();

/** Links a watch took: Chrome hands one connection to every watch, the taker ending first. */
const claimed = new WeakSet<OriginPort>();

const follow = (tabId: number, by: number) => {
  const count = (followed.get(tabId) ?? 0) + by;
  if (count > 0) followed.set(tabId, count);
  else followed.delete(tabId);
};

/**
 * Hands `settle` the first expected agent of the tab's committed document, once the commit names
 * it, and ends the tab's other links; another followed tab's links are left to its own watch.
 */
function agentLinks(target: Target, settle: Settle<OriginPort>): TabListeners {
  const { tabId, origin } = target;
  let documentId: string | undefined;
  let taken = false;
  const waiting = new Set<OriginPort>();
  const offer = (port: OriginPort) => {
    if (documentId === undefined) return void waiting.add(port);
    // Two barriers on one origin each inject an agent, so one document can open two links.
    if (taken || !isExpectedAgent(port, { tabId, documentId, origin })) return port.disconnect();
    taken = true;
    claimed.add(port);
    settle.resolve(port);
  };
  follow(tabId, 1);
  return {
    onCommit: (commit) => {
      if (!sameOrigin(commit.url, origin)) return settle.reject(offOrigin());
      documentId = commit.documentId;
      const early = [...waiting];
      waiting.clear();
      for (const port of early) offer(port);
    },
    onConnect: (port) => {
      if (port.name !== ORIGIN_AGENT_PORT) return;
      const from = port.sender?.tab?.id;
      if (from === tabId) offer(port);
      else if (!claimed.has(port) && (from === undefined || !followed.has(from))) port.disconnect();
    },
    onEnd: () => {
      follow(tabId, -1);
      for (const port of waiting) port.disconnect();
    },
  };
}

/**
 * Navigates the barrier's tab to `url` and resolves with the origin agent of the document it
 * committed. Ports can arrive before the commit names the document, so they wait for it; the
 * tab's other agent links and those of tabs no watch follows are ended, and other extension ports
 * are left to their own listeners.
 */
export function openBehindBarrier(
  api: NavigationApi,
  target: Target,
  boundMs: number,
): Promise<OriginPort> {
  const { tabId, url } = target;
  const late = () =>
    new WorkspaceError("AgentNotConnected", "The page did not open its link in time.");
  return watchTab<OriginPort>(
    api,
    { tabId, boundMs, late, start: () => api.update(tabId, url) },
    (settle) => agentLinks(target, settle),
  );
}

interface Released {
  tabId: number;
  /** The barrier's document, which the reload replaces. */
  documentId: string;
}

/**
 * Reloads the tab and resolves with the id of the new document it committed on any http(s) host:
 * the barrier hands a cross-origin redirect, such as the app's sign-in, over to this reload.
 */
export function reloadAndCommit(
  api: NavigationApi,
  released: Released,
  boundMs: number,
): Promise<string> {
  const { tabId } = released;
  const late = () => new WorkspaceError("NavigationTimedOut", "The page did not reload in time.");
  return watchTab<string>(
    api,
    { tabId, boundMs, late, start: () => api.reload(tabId, released.documentId) },
    (settle) => ({
      onCommit: (commit) => {
        if (commit.documentId === released.documentId) return;
        if (!isWeb(commit.url)) settle.reject(offWeb());
        else settle.resolve(commit.documentId ?? "");
      },
    }),
  );
}

/** Runs in the barrier's document, serialized: it may use nothing from this module. */
function reloadDocument(): void {
  location.reload();
}

/** Tab navigation through Chrome; the getters reach `webNavigation` only in builds that have it. */
export const chromeNavigationApi: NavigationApi = {
  update: async (tabId, url) => {
    await browser.tabs.update(tabId, { url });
  },
  // A `tabs.reload` keeps the extension as the initiator (navigation_entry_impl.cc), so the request
  // would lack SameSite=Strict cookies; the page's own reload names the page's origin instead.
  reload: async (tabId, documentId) => {
    await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      world: "ISOLATED",
      func: reloadDocument,
    });
  },
  get onCommitted() {
    return browser.webNavigation.onCommitted;
  },
  get onErrorOccurred() {
    return browser.webNavigation.onErrorOccurred;
  },
  get onTabRemoved() {
    return browser.tabs.onRemoved;
  },
  get onConnect() {
    return browser.runtime.onConnect;
  },
};

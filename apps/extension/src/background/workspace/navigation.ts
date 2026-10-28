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

/**
 * Navigates the barrier's tab to `url` and resolves with the origin agent of the document it
 * committed. Ports can arrive before the commit names the document, so they wait for it; every
 * other agent link is ended, and other extension ports are left to their own listeners.
 */
export function openBehindBarrier(
  api: NavigationApi,
  target: Target,
  boundMs: number,
): Promise<OriginPort> {
  const { tabId, url, origin } = target;
  const late = () =>
    new WorkspaceError("AgentNotConnected", "The page did not open its link in time.");
  return watchTab<OriginPort>(
    api,
    { tabId, boundMs, late, start: () => api.update(tabId, url) },
    (settle) => {
      let documentId: string | undefined;
      const waiting = new Set<OriginPort>();
      const offer = (port: OriginPort) => {
        if (documentId === undefined) waiting.add(port);
        else if (isExpectedAgent(port, { tabId, documentId, origin })) settle.resolve(port);
        else port.disconnect();
      };
      return {
        onCommit: (commit) => {
          if (!sameOrigin(commit.url, origin)) return settle.reject(offOrigin());
          documentId = commit.documentId;
          const early = [...waiting];
          waiting.clear();
          for (const port of early) offer(port);
        },
        onConnect: (port) => {
          if (port.name === ORIGIN_AGENT_PORT) offer(port);
        },
        onEnd: () => {
          for (const port of waiting) port.disconnect();
        },
      };
    },
  );
}

interface Released {
  tabId: number;
  origin: string;
  /** The barrier's document, which the reload replaces. */
  documentId: string;
}

/** Reloads the tab and resolves with the id of the new document it committed on the target origin. */
export function reloadAndCommit(
  api: NavigationApi,
  released: Released,
  boundMs: number,
): Promise<string> {
  const { tabId, origin } = released;
  const late = () => new WorkspaceError("NavigationTimedOut", "The page did not reload in time.");
  return watchTab<string>(
    api,
    { tabId, boundMs, late, start: () => api.reload(tabId, released.documentId) },
    (settle) => ({
      onCommit: (commit) => {
        if (commit.documentId === released.documentId) return;
        if (!sameOrigin(commit.url, origin)) settle.reject(offOrigin());
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

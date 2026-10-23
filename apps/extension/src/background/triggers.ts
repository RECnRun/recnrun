import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { endSessionOf, floatSessionOn, openSessionFrom } from "@/background/open-session";
import type { SessionStore } from "@/background/open-session";
import { SessionRequestSchema } from "@/messaging/session-protocol";
import { isHeld, PANEL_LOCK } from "@/messaging/view-locks";
import * as v from "valibot";

type Tab = Browser.tabs.Tab;

const OPEN_SESSION = "open-session";
const OPEN_DASHBOARD = "open-dashboard";
const OPEN_RECNRUN = "open-recnrun";

// No documentUrlPatterns: in a frame Chrome matches the frame's URL, which hides the item over
// the dashboard frame on recnrun.com. Chrome never shows extension items on chrome:// pages.
export const PAGE_MENU_ITEM = {
  id: OPEN_RECNRUN,
  title: "Open RECnRun",
  contexts: ["page", "frame"],
} satisfies Browser.contextMenus.CreateProperties;

export const DASHBOARD_MENU_ITEM = {
  id: OPEN_DASHBOARD,
  title: "Dashboard",
  contexts: ["action"],
} satisfies Browser.contextMenus.CreateProperties;

/** What the triggers act on, injected so unit tests need no lock or real storage. */
export interface TriggerTargets {
  sessionUrl: string;
  dashboardUrl: string;
  store: SessionStore;
  /** Whether the session floats in a PiP window, which triggers leave where it is. */
  panelOpen: () => Promise<boolean>;
}

export interface Triggers {
  openSession: (tab?: Tab) => Promise<void>;
  openDashboard: () => Promise<void>;
}

export function createTriggers(targets: TriggerTargets): Triggers {
  return {
    openSession: async (tab) => {
      // Moving the pane would bring back what the floating session keeps out of the way.
      if (await targets.panelOpen()) return;
      await openSessionFrom(tab, targets.sessionUrl, targets.store);
    },
    openDashboard: async () => {
      // The dashboard has no limit, so every trigger opens a new one.
      await browser.tabs.create({ url: targets.dashboardUrl });
    },
  };
}

/** Answers session requests from the extension's own pages, never from its content scripts. */
export function createSessionListener(
  triggers: Triggers,
  store: SessionStore,
  extensionUrl: string,
) {
  return (message: unknown, sender: Browser.runtime.MessageSender) => {
    const request = v.safeParse(SessionRequestSchema, message);
    // A content script shares the extension id but runs in a web page that may be compromised.
    if (sender.id !== browser.runtime.id || !sender.url?.startsWith(extensionUrl)) return false;
    if (!request.success) return false;
    const { type, tabId } = request.output;
    if (type === "float-session") void floatSessionOn(tabId, store);
    else void browser.tabs.get(tabId).then(triggers.openSession, () => {});
    return false;
  };
}

/** Wires the toolbar icon, the context menus, the keyboard commands, and the dashboards' requests. */
export function registerTriggers(targets: TriggerTargets): Triggers {
  const triggers = createTriggers(targets);
  browser.action.onClicked.addListener((tab) => void triggers.openSession(tab));
  browser.commands.onCommand.addListener((command, tab) => {
    if (command === OPEN_SESSION) void triggers.openSession(tab);
    if (command === OPEN_DASHBOARD) void triggers.openDashboard();
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === OPEN_RECNRUN) void triggers.openSession(tab);
    if (info.menuItemId === OPEN_DASHBOARD) void triggers.openDashboard();
  });
  browser.tabs.onRemoved.addListener((tabId) => void endSessionOf(tabId, targets.store));
  browser.runtime.onMessage.addListener(
    createSessionListener(triggers, targets.store, browser.runtime.getURL("/")),
  );
  // Menu items persist across service worker restarts, so create them once per install or update.
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create(DASHBOARD_MENU_ITEM);
    browser.contextMenus.create(PAGE_MENU_ITEM);
  });
  return triggers;
}

/** The triggers of the running extension, over its session storage and panel lock. */
export function defaultTargets(store: SessionStore): TriggerTargets {
  return {
    sessionUrl: browser.runtime.getURL("/session.html"),
    dashboardUrl: browser.runtime.getURL("/dashboard.html"),
    store,
    panelOpen: () => isHeld(PANEL_LOCK),
  };
}

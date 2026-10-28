import { browser } from "wxt/browser";
import { chromeDashboardBrowser } from "@/background/chrome-dashboard-browser";
import { createDashboardOpener } from "@/background/dashboard-opener";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

/** Keeps a dashboard in front of the user: on the toolbar icon, on install, and as the profile opens. */
function openDashboardOnDemand() {
  const url = browser.runtime.getURL("/dashboard.html");
  const opener = createDashboardOpener(chromeDashboardBrowser(url), url);
  browser.action.onClicked.addListener(({ windowId, incognito }) => {
    void opener.show({ windowId, incognito });
  });
  // Chrome restores a profile's windows before the worker starts, so both look at what is open.
  browser.runtime.onInstalled.addListener(() => void opener.lead());
  browser.runtime.onStartup.addListener(() => void opener.lead());
  browser.windows.onCreated.addListener(({ id = -1, type, incognito }) => {
    void opener.windowOpened({ id, type, incognito });
  });
  return opener;
}

export function startBackground(): void {
  const opener = openDashboardOnDemand();
  // Closing a tab never ends the session; only Stop, in a dashboard or the PiP window, does.
  const routes = createRoutes({
    extensionVersion: browser.runtime.getManifest().version,
    store: recordingSessionRepository,
    showDashboard: opener.show,
  });
  const identity = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  browser.runtime.onMessage.addListener(createBackgroundListener(routes, identity));
}

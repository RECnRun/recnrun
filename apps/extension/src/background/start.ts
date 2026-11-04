import { browser } from "wxt/browser";
import { chromeDashboardBrowser } from "@/background/chrome-dashboard-browser";
import { createDashboardOpener } from "@/background/dashboard-opener";
import { createBackgroundListener } from "@/background/listener";
import { startPeers } from "@/background/peers";
import { createRoutes } from "@/background/routes";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
// Imported last, so the production bundle (which drops them) keeps its module order and bytes.
import { startDownloadsPublisher } from "@/background/downloads-publisher";
import { startPocFileReadRelay } from "@/background/poc-file-read";

// pocEnabled() spelled out, not called, so the production build can drop chrome.downloads calls.
const POC =
  import.meta.env.MODE === "poc-d0" ||
  import.meta.env.MODE === "poc-d1" ||
  import.meta.env.MODE === "poc-d2";
// Spelled out like peersEnabled(), not called, so production drops the cross-profile mesh.
const PEERS = import.meta.env.MODE === "development" || import.meta.env.MODE === "test" || POC;

/** Keeps a dashboard in front of the user: on the toolbar icon, on install, and as the profile opens. */
function openDashboardOnDemand() {
  const url = browser.runtime.getURL("/dashboard.html");
  const opener = createDashboardOpener(chromeDashboardBrowser(url), url);
  browser.action.onClicked.addListener(({ windowId, incognito }) => {
    void opener.show({ windowId, incognito });
  });
  // A POC worker starts silently (source §9): only the toolbar icon opens its dashboard.
  if (POC) return opener;
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
    peers: PEERS ? startPeers({ transport: POC ? "downloads" : "folder" }) : undefined,
  });
  const identity = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  browser.runtime.onMessage.addListener(createBackgroundListener(routes, identity));
  if (POC) startDownloadsPublisher();
  if (POC) startPocFileReadRelay();
}

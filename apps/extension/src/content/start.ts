import { createBridgeHost, createWindowTransport } from "@recnrun/bridge";
import { browser } from "wxt/browser";
import { mountDashboardFrame } from "@/content/dashboard-frame";
import { createForwardingHandler } from "@/content/forward";
import { showIncognitoNotice } from "@/content/incognito-notice";
import { servePanelRequests } from "@/content/panel-window";

export function startContentBridge(): void {
  createBridgeHost(
    createWindowTransport(),
    createForwardingHandler((message) => browser.runtime.sendMessage(message)),
    browser.runtime.getManifest().version,
  );
  // In spanning mode Chrome shows no extension page in an incognito tab, so no dashboard there.
  if (browser.extension.inIncognitoContext) return showIncognitoNotice();
  const dashboardUrl = browser.runtime.getURL("/dashboard.html");
  const extensionOrigin = new URL(dashboardUrl).origin;
  const frame = mountDashboardFrame(dashboardUrl, extensionOrigin);
  servePanelRequests(frame, browser.runtime.getURL("/session.html"), extensionOrigin);
}

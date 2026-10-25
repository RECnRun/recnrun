import { createBridgeHost, createWindowTransport } from "@recnrun/bridge";
import { browser } from "wxt/browser";
import { createForwardingHandler } from "@/content/forward";
import { INCOGNITO_NOTICE, showNotice } from "@/content/notice";
import { startSiteSession } from "@/content/site-session";
import { SITE_PORT } from "@/messaging/site-port";

export function startContentBridge(): void {
  createBridgeHost(
    createWindowTransport(),
    createForwardingHandler((message) => browser.runtime.sendMessage(message)),
    browser.runtime.getManifest().version,
  );
  // In spanning mode Chrome shows no extension page in an incognito tab, so no dashboard there.
  if (browser.extension.inIncognitoContext) return showNotice(INCOGNITO_NOTICE);
  const dashboardUrl = browser.runtime.getURL("/dashboard.html");
  startSiteSession(
    {
      dashboardUrl,
      sessionUrl: browser.runtime.getURL("/session.html"),
      extensionOrigin: new URL(dashboardUrl).origin,
    },
    () => browser.runtime.connect({ name: SITE_PORT }),
  );
}

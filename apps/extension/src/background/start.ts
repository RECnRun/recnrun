import { browser } from "wxt/browser";
import { createMessageListener, createRequestHandler } from "@/background/handler";
import { createOpenDashboardListener, matchesOrigins } from "@/background/open-dashboard";
import { contentScriptMatches } from "@/config/origins";
import { readSnapshot } from "@/storage/snapshot-repository";

export function startBackground(): void {
  const handle = createRequestHandler({
    extensionVersion: browser.runtime.getManifest().version,
    readSnapshot,
  });
  browser.runtime.onMessage.addListener(createMessageListener(handle, browser.runtime.id));
  browser.runtime.onMessage.addListener(
    createOpenDashboardListener({
      extensionId: browser.runtime.id,
      isAllowedPage: matchesOrigins(contentScriptMatches(import.meta.env.MODE)),
      openInTab: (tabId) =>
        browser.tabs.update(tabId, { url: browser.runtime.getURL("/dashboard.html") }),
    }),
  );
}

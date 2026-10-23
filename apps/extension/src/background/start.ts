import { browser } from "wxt/browser";
import { createMessageListener, createRequestHandler } from "@/background/handler";
import { registerDashboardTriggers } from "@/background/open-dashboard";

export function startBackground(): void {
  const handle = createRequestHandler({ extensionVersion: browser.runtime.getManifest().version });
  browser.runtime.onMessage.addListener(createMessageListener(handle, browser.runtime.id));
  const openDashboard = registerDashboardTriggers();
  // Playwright cannot click the toolbar, menus, or shortcuts, so test builds expose the shared action.
  if (import.meta.env.MODE === "test") {
    Object.assign(globalThis, { recnrunOpenDashboard: openDashboard });
  }
}

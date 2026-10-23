import { browser } from "wxt/browser";
import { createMessageListener, createRequestHandler } from "@/background/handler";
import { defaultTargets, registerTriggers } from "@/background/triggers";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

export function startBackground(): void {
  const handle = createRequestHandler({ extensionVersion: browser.runtime.getManifest().version });
  browser.runtime.onMessage.addListener(createMessageListener(handle, browser.runtime.id));
  const triggers = registerTriggers(defaultTargets(recordingSessionRepository));
  // Playwright cannot click the toolbar, menus, or shortcuts, so test builds expose the actions.
  if (import.meta.env.MODE === "test") {
    Object.assign(globalThis, {
      recnrunOpenSession: triggers.openSession,
      recnrunOpenDashboard: triggers.openDashboard,
    });
  }
}

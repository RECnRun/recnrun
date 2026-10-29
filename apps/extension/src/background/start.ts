import { browser } from "wxt/browser";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import { installTestHandles } from "@/background/test-handles";
import { chromeBootstrapPorts, createWorkspaceCommands } from "@/background/workspace/commands";
import { chromeCookieApi, trackIncognitoStores } from "@/background/workspace/cookie-stores";
import { trackFocusedWindow, trackVisitedOrigins } from "@/background/workspace/visited-origins";
import { trackManagedWindow } from "@/background/workspace/windows";
import { incognitoStoreMemory } from "@/storage/incognito-stores";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

export function startBackground(): void {
  const ports = chromeBootstrapPorts();
  const workspace = createWorkspaceCommands(recordingSessionRepository, ports);
  // A start the previous worker left running died with it; an unhandled failure here is logged.
  void workspace.recover();
  // A static check of the mode lets the production build drop the test handles entirely.
  if (import.meta.env.MODE === "test") {
    installTestHandles(globalThis, workspace, ports.hooks, browser.runtime.onConnect);
  }
  // Closing a tab never ends the session; only Stop, in a dashboard or the PiP window, does.
  const routes = createRoutes({
    extensionVersion: browser.runtime.getManifest().version,
    store: recordingSessionRepository,
    workspace,
  });
  const identity = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  browser.runtime.onMessage.addListener(createBackgroundListener(routes, identity));
  trackManagedWindow();
  trackVisitedOrigins();
  trackFocusedWindow();
  trackIncognitoStores(chromeCookieApi, incognitoStoreMemory);
}

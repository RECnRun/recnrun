import { browser } from "wxt/browser";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import { installTestHandles } from "@/background/test-handles";
import { routeAgentPorts } from "@/background/workspace/agent-ports";
import { chromeBootstrapPorts, createWorkspaceCommands } from "@/background/workspace/commands";
import { chromeCookieApi, trackIncognitoStores } from "@/background/workspace/cookie-stores";
import { answerResponseUrls } from "@/background/workspace/response-urls";
import { trackFocusedWindow, trackVisitedOrigins } from "@/background/workspace/visited-origins";
import { trackManagedWindow } from "@/background/workspace/windows";
import { incognitoStoreMemory } from "@/storage/incognito-stores";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { responseUrlStore } from "@/storage/response-urls";

export function startBackground(): void {
  const ports = chromeBootstrapPorts();
  const workspace = createWorkspaceCommands(recordingSessionRepository, ports);
  // A start the previous worker left running died with it; an unhandled failure here is logged.
  void workspace.recover();
  // A static check of the mode lets the production build drop the test handles entirely.
  if (import.meta.env.MODE === "test") {
    installTestHandles(globalThis, workspace, ports.hooks, browser.runtime.onConnect);
  }
  // Routed after the test handles wrap `onConnect`, so the stale replay reaches the waits.
  routeAgentPorts(browser.runtime.onConnect);
  // Closing a tab never ends the session; only Stop, in a dashboard or the PiP window, does.
  const routes = createRoutes({
    extensionVersion: browser.runtime.getManifest().version,
    store: recordingSessionRepository,
    workspace,
    responseUrls: (sender) =>
      answerResponseUrls(sender, {
        responseUrls: responseUrlStore,
        managed: () => managedWindowRepository.read(),
      }),
  });
  const identity = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  browser.runtime.onMessage.addListener(createBackgroundListener(routes, identity));
  trackManagedWindow();
  trackVisitedOrigins();
  trackFocusedWindow();
  trackIncognitoStores(chromeCookieApi, incognitoStoreMemory);
}

import { browser } from "wxt/browser";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import { createWorkspaceCommands } from "@/background/workspace/commands";
import { trackManagedWindow } from "@/background/workspace/windows";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

export function startBackground(): void {
  // Closing a tab never ends the session; only Stop, in a dashboard or the PiP window, does.
  const routes = createRoutes({
    extensionVersion: browser.runtime.getManifest().version,
    store: recordingSessionRepository,
    workspace: createWorkspaceCommands(recordingSessionRepository),
  });
  const identity = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  browser.runtime.onMessage.addListener(createBackgroundListener(routes, identity));
  trackManagedWindow();
}

import { browser } from "wxt/browser";
import { createMessageListener, createRequestHandler } from "@/background/handler";
import { startPeers } from "@/background/peers";
import { createSessionListener } from "@/background/session-requests";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

export function startBackground(): void {
  const handle = createRequestHandler({ extensionVersion: browser.runtime.getManifest().version });
  browser.runtime.onMessage.addListener(createMessageListener(handle, browser.runtime.id));
  // Closing a tab never ends the session; only Stop, in a dashboard or the PiP window, does.
  const listen = createSessionListener(recordingSessionRepository, browser.runtime.getURL("/"));
  browser.runtime.onMessage.addListener(listen);
  // Literal comparisons, which the bundler folds, so a production build ships no POC code.
  if (import.meta.env.MODE === "development" || import.meta.env.MODE === "test") startPeers();
}

import { browser } from "wxt/browser";
import { createMessageListener, createRequestHandler } from "@/background/handler";
import { createSessionListener, endSessionOf } from "@/background/session-requests";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

export function startBackground(): void {
  const handle = createRequestHandler({ extensionVersion: browser.runtime.getManifest().version });
  browser.runtime.onMessage.addListener(createMessageListener(handle, browser.runtime.id));
  const store = recordingSessionRepository;
  browser.runtime.onMessage.addListener(createSessionListener(store, browser.runtime.getURL("/")));
  browser.tabs.onRemoved.addListener((tabId) => void endSessionOf(tabId, store));
}

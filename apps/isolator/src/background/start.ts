import { browser } from "wxt/browser";

/** `chrome.storage.session` key the harness reads to see that the background ran. */
export const LOADED_KEY = "isolatorLoaded";
export const GET_SELF = "isolator:getSelf";

function isGetSelfRequest(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === GET_SELF
  );
}

async function recordLoaded(): Promise<void> {
  const marker = {
    loaded: true,
    id: browser.runtime.id,
    version: browser.runtime.getManifest().version,
  };
  await browser.storage.session.set({ [LOADED_KEY]: marker });
}

export function startBackground(): void {
  const record = (): void => void recordLoaded();
  browser.runtime.onInstalled.addListener(record);
  browser.runtime.onStartup.addListener(record);
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || !isGetSelfRequest(message)) return false;
    void browser.management.getSelf().then(sendResponse);
    // Keeps the channel open for the asynchronous reply.
    return true;
  });
}

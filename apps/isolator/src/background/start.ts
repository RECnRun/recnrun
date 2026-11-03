import { browser } from "wxt/browser";
import { exposeProbes } from "@/background/probes/expose";
import { exposeRouteA } from "@/background/route-a/expose";
import { exposeRouteB } from "@/background/route-b/expose";
import { exposeRouteC } from "@/background/route-c/expose";
import { exposeStop } from "@/background/stop/expose";

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
  exposeProbes(
    () => browser.debugger,
    async (tabId) => (await browser.tabs.get(tabId)).height,
  );
  exposeRouteA(() => browser.debugger);
  exposeRouteC(() => browser.scripting);
  exposeRouteB(
    () => browser.debugger,
    () => browser.runtime.getURL("/"),
  );
  exposeStop(() => ({
    debugger: browser.debugger,
    dnr: browser.declarativeNetRequest,
    tabs: browser.tabs,
  }));
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

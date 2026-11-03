import { browser } from "wxt/browser";
import { LabChannel } from "@/background/lab/channel";
import type { LabApis, ReportInjection } from "@/background/lab/types";

async function postJson(url: string, body: unknown): Promise<void> {
  const init = { method: "POST", headers: { "content-type": "application/json" } };
  const response = await fetch(url, { ...init, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`POST ${url} answered ${response.status}`);
}

function labApis(): LabApis {
  const extensionOrigin = browser.runtime.getURL("/");
  return {
    debugger: browser.debugger,
    managed: browser.storage.managed,
    scripting: {
      executeScript: (injection: ReportInjection) => browser.scripting.executeScript(injection),
    },
    selection: {
      debugger: browser.debugger,
      dnr: browser.declarativeNetRequest,
      storage: browser.storage.session,
      extensionOrigin,
    },
    extensionOrigin,
    id: browser.runtime.id,
    version: browser.runtime.getManifest().version,
    post: postJson,
  };
}

/** Starts the strict lab's channel (E8); it stays inert unless a policy sets the managed `lab` key. */
export function exposeLab(): void {
  const channel = new LabChannel(labApis);
  // Added at start, so the events wake a stopped background and reach the channel.
  browser.tabs.onUpdated.addListener((tabId, change, tab) =>
    channel.tabUpdated(tabId, change, tab),
  );
  browser.storage.onChanged.addListener((_changes, area) => {
    if (area === "managed") void channel.managedChanged();
  });
  void channel.start();
}

import { browser } from "wxt/browser";
import { createMessageListener, createRequestHandler } from "@/background/handler";
import { readSnapshot } from "@/storage/snapshot-repository";

export function startBackground(): void {
  const handle = createRequestHandler({
    extensionVersion: browser.runtime.getManifest().version,
    readSnapshot,
  });
  browser.runtime.onMessage.addListener(createMessageListener(handle, browser.runtime.id));
}

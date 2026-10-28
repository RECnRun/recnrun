import { createBridgeHost, createWindowTransport } from "@recnrun/bridge";
import { browser } from "wxt/browser";
import { createForwardingHandler } from "@/content/forward";

export function startContentBridge(): void {
  createBridgeHost(
    createWindowTransport(),
    createForwardingHandler((message) => browser.runtime.sendMessage(message)),
    browser.runtime.getManifest().version,
  );
}

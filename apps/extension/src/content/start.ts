import { createBridgeHost, createWindowTransport } from "@recnrun/bridge";
import { browser } from "wxt/browser";
import { createForwardingHandler } from "@/content/forward";
import { createTimelineRelay } from "@/content/timeline";
import { TIMELINE_PORT } from "@/messaging/background-protocol";

const RECONNECT_MS = 1000;

export function startContentBridge(): void {
  const host = createBridgeHost(
    createWindowTransport(),
    createForwardingHandler((message) => browser.runtime.sendMessage(message)),
    browser.runtime.getManifest().version,
  );
  createTimelineRelay(
    () => browser.runtime.connect({ name: TIMELINE_PORT }),
    host.emit,
    RECONNECT_MS,
  );
}

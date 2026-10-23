import { createBridgeHost, createWindowTransport } from "@recnrun/bridge";
import { browser } from "wxt/browser";
import { mountDashboardFrame } from "@/content/dashboard-frame";
import { createForwardingHandler } from "@/content/forward";

export function startContentBridge(): void {
  createBridgeHost(
    createWindowTransport(),
    createForwardingHandler((message) => browser.runtime.sendMessage(message)),
    browser.runtime.getManifest().version,
  );
  // With `use_dynamic_url` the frame URL host is a per-session id, but its origin stays the real one.
  mountDashboardFrame(
    browser.runtime.getURL("/dashboard.html"),
    `chrome-extension://${browser.runtime.id}`,
  );
}

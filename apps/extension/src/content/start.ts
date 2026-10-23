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
  const dashboardUrl = browser.runtime.getURL("/dashboard.html");
  mountDashboardFrame(dashboardUrl, new URL(dashboardUrl).origin);
}

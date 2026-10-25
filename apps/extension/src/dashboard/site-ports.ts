import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { SITE_PORT } from "@/messaging/site-port";

const held = new Set<Browser.runtime.Port>();

/** Holds each site tab's port open while this frame, and so RECnRun, stays loaded; returns what it holds. */
export function holdSitePorts(): ReadonlySet<Browser.runtime.Port> {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== SITE_PORT) return;
    held.add(port);
    port.onDisconnect.addListener(() => held.delete(port));
  });
  return held;
}

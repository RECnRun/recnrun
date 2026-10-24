import { browser } from "wxt/browser";
import { ask } from "@/messaging/peer-protocol";
import type { LinkCommand } from "@/messaging/peer-protocol";

const OFFSCREEN_PATH = "/offscreen.html";
let creating: Promise<void> | undefined;

/** Built from the root, since development-only pages are missing from WXT's typed paths. */
export const offscreenUrl = () => new URL(OFFSCREEN_PATH, browser.runtime.getURL("/")).href;

/** One offscreen document holds the RTCPeerConnection, which a service worker cannot. */
export async function ensureOffscreen(): Promise<void> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl()],
  });
  if (contexts.length > 0) return;
  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [browser.offscreen.Reason.WEB_RTC],
      justification: "Holds the WebRTC DataChannel to another RECnRun profile.",
    })
    .finally(() => (creating = undefined));
  await creating;
}

/** Sends a command to the offscreen document, creating it first if needed. */
export async function askLink(command: Omit<LinkCommand, "target">): Promise<unknown> {
  await ensureOffscreen();
  return ask((message) => browser.runtime.sendMessage(message), {
    target: "offscreen",
    ...command,
  });
}

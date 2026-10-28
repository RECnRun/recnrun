import * as v from "valibot";
import { browser } from "wxt/browser";
import { OFFSCREEN_PAGE } from "@/background/listener";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import { linkCommandMessage } from "@/messaging/peer-messages";
import type { LinkCommand } from "@/messaging/peer-messages";

let creating: Promise<void> | undefined;

/** One offscreen document holds the RTCPeerConnection, which a service worker cannot. */
async function ensureOffscreen(): Promise<void> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  // Two commands at once would otherwise both create it, and Chrome refuses the second.
  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_PAGE,
      reasons: [browser.offscreen.Reason.WEB_RTC],
      justification: "Holds the WebRTC DataChannel to another RECnRun profile.",
    })
    .finally(() => (creating = undefined));
  await creating;
}

/** Sends a command to the offscreen document, creating it first, and unwraps its reply. */
export async function askLink(command: LinkCommand): Promise<unknown> {
  await ensureOffscreen();
  const reply = v.safeParse(
    BackgroundReplySchema,
    await browser.runtime.sendMessage(linkCommandMessage(command)),
  );
  if (!reply.success) throw new Error("The link did not answer.");
  if (!reply.output.ok) throw new Error(reply.output.error);
  return reply.output.result;
}

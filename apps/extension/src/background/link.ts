import * as v from "valibot";
import { browser } from "wxt/browser";
import { OFFSCREEN_PAGE } from "@/background/listener";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import { linkCommandMessage } from "@/messaging/peer-messages";
import type { LinkCommand } from "@/messaging/peer-messages";
import { PocFingerprintResultSchema, pocFingerprintRequest } from "@/messaging/poc-fingerprint";
import { PocLivenessResultSchema, pocLivenessRequest } from "@/messaging/poc-liveness";
import type { LinkLiveness } from "@/messaging/poc-liveness";

let creating: Promise<void> | undefined;
// Read through a function, so a check after an await is not narrowed to the value before it.
const pending = () => creating;

/** One offscreen document holds the RTCPeerConnection, which a service worker cannot. */
export async function ensureOffscreen(): Promise<void> {
  // getContexts() lists the frame before its page has loaded, so a pending creation is awaited first.
  if (creating) return creating;
  const contexts = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  const racing = pending();
  if (racing) return racing;
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

/**
 * Closes the offscreen document, and every folder handle it holds. Chrome shows its restore
 * prompt, with "Allow on every visit", only for a grant that a handle loaded from storage created;
 * a live handle keeps the picker's grant instead (`GetWritePermissionGrant` in Chromium's
 * chrome_file_system_access_permission_context.cc).
 */
export async function closeOffscreen(): Promise<void> {
  // Closing during a creation would race it, so the creation settles first.
  await creating?.catch(() => {});
  const contexts = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) await browser.offscreen.closeDocument();
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

/** A POC request the offscreen document answers, creating the document first. */
async function askOffscreen<T>(request: unknown, schema: v.GenericSchema<unknown, T>): Promise<T> {
  await ensureOffscreen();
  const reply = v.safeParse(BackgroundReplySchema, await browser.runtime.sendMessage(request));
  if (!reply.success) throw new Error("The offscreen document did not answer.");
  if (!reply.output.ok) throw new Error(reply.output.error);
  return v.parse(schema, reply.output.result);
}

/** The offscreen document's certificate fingerprint, creating the document first. */
export const offscreenFingerprint = async (): Promise<string> =>
  (await askOffscreen(pocFingerprintRequest(), PocFingerprintResultSchema)).fingerprint;

/** When each link of the offscreen document last heard its peer, and the beats it sent (P3.6). */
export const offscreenLiveness = async (): Promise<Record<string, LinkLiveness>> =>
  (await askOffscreen(pocLivenessRequest(), PocLivenessResultSchema)).peers;

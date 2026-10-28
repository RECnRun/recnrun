import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import type { Browser } from "wxt/browser";
import { BackgroundMessageSchema } from "@/messaging/background-messages";
import type { BackgroundMessage } from "@/messaging/background-messages";
import type { BackgroundReply } from "@/messaging/background-reply";

/**
 * Who sent a message: one of this extension's pages, its offscreen document (which holds the
 * cross-profile link), or its content script in a web page.
 */
export type Sender = "ownPage" | "offscreen" | "contentScript";

/** How the background answers one message type: whom it trusts, and what it does. */
export interface Route {
  from: readonly Sender[];
  run: (sender: Browser.runtime.MessageSender) => Promise<unknown>;
}

/** The route for a validated message; `background/routes.ts` is the table. */
export type Routes = (message: BackgroundMessage) => Route;

interface Identity {
  extensionId: string;
  /** The extension origin with a trailing slash, which only its own pages' URLs start with. */
  extensionUrl: string;
}

/** The one document the offscreen sender may be, so no page can pose as the link. */
export const OFFSCREEN_PAGE = "offscreen.html";

/** A content script shares the extension id but runs in a web page that may be compromised. */
function classify(sender: Browser.runtime.MessageSender, identity: Identity): Sender | undefined {
  if (sender.id !== identity.extensionId) return undefined;
  if (sender.url === identity.extensionUrl + OFFSCREEN_PAGE) return "offscreen";
  return sender.url?.startsWith(identity.extensionUrl) ? "ownPage" : "contentScript";
}

/**
 * The one runtime.onMessage listener: validates the message once, refuses senders the route does
 * not trust, and replies through sendResponse, which every Chromium version supports.
 */
export function createBackgroundListener(routes: Routes, identity: Identity) {
  return (
    message: unknown,
    sender: Browser.runtime.MessageSender,
    sendResponse: (reply: BackgroundReply) => void,
  ) => {
    const parsed = v.safeParse(BackgroundMessageSchema, message);
    const from = classify(sender, identity);
    if (!parsed.success || from === undefined) return false;
    const route = routes(parsed.output);
    if (!route.from.includes(from)) return false;
    route.run(sender).then(
      (result) => sendResponse({ ok: true, result }),
      (error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }),
    );
    return true;
  };
}

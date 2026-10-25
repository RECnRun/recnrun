import * as v from "valibot";
import type { TakeControl } from "@/dashboard/TabList";
import { BackgroundReplySchema } from "@/messaging/background-messages";
import { subscribeFrame } from "@/messaging/frame-channel";
import { openPanelMessage } from "@/messaging/frame-protocol";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import { CONTROL_LOCK, tryHoldLock } from "@/messaging/view-locks";

/** Sends a session request to the background and resolves with its reply, validated here. */
export type SendRequest = (request: SessionRequest) => Promise<unknown>;

const CONTROLLED_ELSEWHERE = "Another RECnRun tab controls the session.";

/** Rejects with the background's error, or when the reply is not one. */
async function ask(send: SendRequest, request: SessionRequest): Promise<void> {
  const reply = v.parse(BackgroundReplySchema, await send(request));
  if (!reply.ok) throw new Error(reply.error);
}

/**
 * The control lock, taken atomically across every dashboard, makes this one the only one with a
 * PiP window. A frame cannot open that window, so the site's content script opens it, and says
 * when it closes; the lock then frees, and the site tab gets the focus back.
 */
export function controlFrom(page: Window, parent: string, send: SendRequest): TakeControl {
  let release: (() => void) | undefined;
  subscribeFrame(page, page.parent, parent, {
    "panel-closed": () => {
      if (!release) return;
      release();
      release = undefined;
      // The focus either moves back or not; the dashboard has nothing to show about it.
      void ask(send, returnToDashboardMessage()).catch(() => {});
    },
  });
  return async (tabId) => {
    if (release) return;
    release = await tryHoldLock(CONTROL_LOCK);
    if (!release) throw new Error(CONTROLLED_ELSEWHERE);
    page.parent.postMessage(openPanelMessage(), parent);
    try {
      await ask(send, startSessionMessage(tabId));
    } catch (error) {
      // No session started, so this dashboard controls nothing; the error reaches the tab list.
      release();
      release = undefined;
      throw error;
    }
  };
}

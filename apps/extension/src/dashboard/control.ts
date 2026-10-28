import * as v from "valibot";
import type { TakeControl } from "@/dashboard/TabList";
import { BackgroundReplySchema } from "@/messaging/background-messages";
import { subscribeFrame } from "@/messaging/frame-channel";
import { openPanelMessage } from "@/messaging/frame-protocol";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import { documentPip, requestPanelWindow } from "@/pip/document-pip";
import type { DocumentPictureInPicture } from "@/pip/document-pip";
import type { SendRequest } from "@/views/extension-services";
import { announce, CONTROL_LOCK, tryHoldLock } from "@/views/view-locks";

const CONTROLLED_ELSEWHERE = "Another RECnRun tab controls the session.";

/** Rejects with the background's error, or when the reply is not one. */
async function ask(send: SendRequest, request: SessionRequest): Promise<void> {
  const reply = v.parse(BackgroundReplySchema, await send(request));
  if (!reply.ok) throw new Error(reply.error);
}

/** The control lock as one dashboard holds it, taken atomically across every dashboard. */
function controlLock() {
  let release: (() => void) | undefined;
  return {
    held: () => release !== undefined,
    async take() {
      release = await tryHoldLock(CONTROL_LOCK);
      if (!release) throw new Error(CONTROLLED_ELSEWHERE);
    },
    free() {
      release?.();
      release = undefined;
    },
  };
}

/** Frees the control once the PiP window closes, and gets the focus back for the dashboard. */
function closedWith(lock: ReturnType<typeof controlLock>, send: SendRequest) {
  return () => {
    if (!lock.held()) return;
    lock.free();
    // The focus either moves back or not; the dashboard has nothing to show about it.
    void ask(send, returnToDashboardMessage()).catch(() => {});
  };
}

/** Starts the session; when it cannot, this dashboard controls nothing and the tab list says why. */
async function start(lock: ReturnType<typeof controlLock>, send: SendRequest, tabId: number) {
  try {
    await ask(send, startSessionMessage(tabId));
  } catch (error) {
    lock.free();
    throw error;
  }
}

/**
 * The control lock makes this dashboard the only one with a PiP window. A frame cannot open that
 * window, so the site's content script opens it, and says when it closes; the lock then frees, and
 * the site tab gets the focus back.
 */
export function controlFrom(page: Window, parent: string, send: SendRequest): TakeControl {
  const lock = controlLock();
  subscribeFrame(page, page.parent, parent, { "panel-closed": closedWith(lock, send) });
  return async (tabId) => {
    if (lock.held()) return;
    await lock.take();
    page.parent.postMessage(openPanelMessage(), parent);
    await start(lock, send, tabId);
  };
}

/** Fills a PiP window the dashboard opened with the session. */
export type FloatSession = (pipWindow: Window) => void;

/** Opens the PiP window, still within the click's user activation, and floats the session in it. */
function openWindow(pip: DocumentPictureInPicture, float: FloatSession, closed: () => void) {
  return requestPanelWindow(pip).then(
    (pipWindow) => {
      float(pipWindow);
      // Chrome drops a broadcast still on its way to this page when the window opens (POC 7).
      announce(CONTROL_LOCK);
      // Fires whether the user closes the window or the session closes it at the end.
      pipWindow.addEventListener("pagehide", closed);
      return pipWindow;
    },
    () => {
      closed();
      return undefined;
    },
  );
}

/** The control for the dashboard in its own tab, which opens its PiP window itself. */
export function controlInTab(page: Window, send: SendRequest, float: FloatSession): TakeControl {
  const lock = controlLock();
  const closed = closedWith(lock, send);
  return async (tabId) => {
    if (lock.held()) return;
    await lock.take();
    const pip = documentPip(page);
    const opened = pip ? openWindow(pip, float, closed) : Promise.resolve(undefined);
    // Without the API the session cannot float, so no dashboard keeps the control.
    if (!pip) lock.free();
    try {
      await start(lock, send, tabId);
    } catch (error) {
      void opened.then((pipWindow) => pipWindow?.close());
      throw error;
    }
  };
}

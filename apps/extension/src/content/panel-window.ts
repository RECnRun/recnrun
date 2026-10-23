import * as v from "valibot";
import { OpenPanelMessageSchema } from "@/messaging/frame-protocol";
import { documentPip, requestPanelWindow, showSession } from "@/pip/document-pip";

/** Opens the session's PiP window for the framed dashboard, since only a top-level page may. */
export function servePanelRequests(
  dashboard: HTMLIFrameElement,
  sessionUrl: string,
  extensionOrigin: string,
  page: Window = window,
): void {
  page.addEventListener("message", (event) => {
    if (event.source !== dashboard.contentWindow || event.origin !== extensionOrigin) return;
    if (!v.is(OpenPanelMessageSchema, event.data)) return;
    const pip = documentPip(page);
    if (!pip) return;
    // The click in the frame also activated this page, so the request still has its gesture.
    void requestPanelWindow(pip).then((pipWindow) =>
      showSession(pipWindow, sessionUrl, extensionOrigin),
    );
  });
}

import { subscribeFrame } from "@/messaging/frame-channel";
import { panelClosedMessage } from "@/messaging/frame-protocol";
import { documentPip, requestPanelWindow, showSession } from "@/pip/document-pip";

/**
 * Opens the session's PiP window for the framed dashboard, since only a top-level page may, and
 * tells the dashboard once the window closes or cannot open, so it gives up the control.
 */
export function servePanelRequests(
  dashboard: HTMLIFrameElement,
  sessionUrl: string,
  extensionOrigin: string,
  page: Window = window,
): void {
  const closed = () => dashboard.contentWindow?.postMessage(panelClosedMessage(), extensionOrigin);
  subscribeFrame(page, dashboard.contentWindow, extensionOrigin, {
    "open-panel": () => {
      const pip = documentPip(page);
      if (!pip) return closed();
      // The click in the frame also activated this page, so the request still has its gesture.
      requestPanelWindow(pip).then((pipWindow) => {
        showSession(pipWindow, sessionUrl, extensionOrigin);
        // Fires whether the user closes the window or the session closes it at the end.
        pipWindow.addEventListener("pagehide", closed);
      }, closed);
    },
  });
}

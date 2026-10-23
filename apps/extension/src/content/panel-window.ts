import * as v from "valibot";
import { ClosePanelMessageSchema, OpenPanelMessageSchema } from "@/messaging/frame-protocol";
import { documentPip, requestPanelWindow } from "@/pip/document-pip";

function showPanel(pipWindow: Window, panelUrl: string, extensionOrigin: string): void {
  const { document } = pipWindow;
  const iframe = document.createElement("iframe");
  iframe.title = "RECnRun recording panel";
  iframe.src = panelUrl;
  Object.assign(iframe.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    border: "0",
  });
  document.body.append(iframe);
  pipWindow.addEventListener("message", (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== extensionOrigin) return;
    if (!v.is(ClosePanelMessageSchema, event.data)) return;
    pipWindow.close();
  });
}

/** Opens the recording panel for the framed dashboard, since only a top-level page may. */
export function servePanelRequests(
  dashboard: HTMLIFrameElement,
  dashboardUrl: string,
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
      showPanel(pipWindow, `${dashboardUrl}?view=panel`, extensionOrigin),
    );
  });
}

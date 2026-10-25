import { mountDashboardFrame } from "@/content/dashboard-frame";
import { ORPHANED_NOTICE, showNotice } from "@/content/notice";
import { watchForOrphaning } from "@/content/orphan-watch";
import { servePanelRequests } from "@/content/panel-window";
import { documentPip } from "@/pip/document-pip";
import type { SitePort } from "@/ports/site-port";

/** Where the extension's pages are, and the origin they answer from. */
export interface ExtensionPages {
  dashboardUrl: string;
  sessionUrl: string;
  extensionOrigin: string;
}

/**
 * Reloads the site once the user comes back to it, as from chrome://extensions after a toggle such
 * as "Allow in Incognito" reloaded RECnRun: the new content script then shows a fresh dashboard,
 * or, with RECnRun off, the site asks to install it.
 */
function reloadOnReturn(page: Window): void {
  const reload = () => {
    if (page.document.visibilityState === "visible") page.location.reload();
  };
  page.document.addEventListener("visibilitychange", reload);
  page.addEventListener("focus", reload);
}

/**
 * The site's session with RECnRun: the dashboard frame over the page, the PiP window the frame
 * asks for, and the watch that ends both when RECnRun reloads or turns off. This script is then
 * orphaned, so it can only ask for a reload, and make it when the user returns.
 */
export function startSiteSession(
  pages: ExtensionPages,
  connect: () => SitePort,
  page: Window = window,
): void {
  const frame = mountDashboardFrame(pages.dashboardUrl, pages.extensionOrigin, page);
  servePanelRequests(frame, pages.sessionUrl, pages.extensionOrigin, page);
  watchForOrphaning(frame, connect, () => {
    // Chrome blanked the session page in the PiP window too, so the window goes with the frame.
    documentPip(page)?.window?.close();
    frame.remove();
    showNotice(ORPHANED_NOTICE, page);
    reloadOnReturn(page);
  });
}

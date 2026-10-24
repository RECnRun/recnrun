import { ORPHANED_NOTICE, showNotice } from "@/content/notice";
import type { SitePort } from "@/messaging/site-port";

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
 * Chrome blanks the dashboard frame when RECnRun reloads or turns off, and fires no event on the
 * site; only the port the frame held disconnects. This script is then orphaned, so it can only
 * ask for a reload, and make it when the user returns.
 */
export function watchForOrphaning(
  frame: HTMLIFrameElement,
  connect: () => SitePort,
  page: Window = window,
): void {
  const orphaned = () => {
    frame.remove();
    showNotice(ORPHANED_NOTICE, page);
    reloadOnReturn(page);
  };
  // The frame listens for the port before it loads; connecting earlier would find no listener.
  frame.addEventListener(
    "load",
    () => {
      try {
        connect().onDisconnect.addListener(orphaned);
      } catch {
        orphaned();
      }
    },
    { once: true },
  );
}

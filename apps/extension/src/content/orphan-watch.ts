import { ORPHANED_NOTICE, showNotice } from "@/content/notice";
import type { SitePort } from "@/messaging/site-port";

/**
 * Chrome blanks the dashboard frame when RECnRun reloads or turns off, and fires no event on the
 * site; only the port the frame held disconnects. This script is then orphaned, so it can only
 * ask for a reload.
 */
export function watchForOrphaning(
  frame: HTMLIFrameElement,
  connect: () => SitePort,
  page: Window = window,
): void {
  const orphaned = () => {
    frame.remove();
    showNotice(ORPHANED_NOTICE, page);
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

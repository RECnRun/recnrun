import type { SitePort } from "@/ports/site-port";

/**
 * Chrome blanks the dashboard frame when RECnRun reloads or turns off, and fires no event on the
 * site; only the port the frame held disconnects. `orphaned` runs then, or at once when there is
 * no RECnRun left to connect to.
 */
export function watchForOrphaning(
  frame: HTMLIFrameElement,
  connect: () => SitePort,
  orphaned: () => void,
): void {
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

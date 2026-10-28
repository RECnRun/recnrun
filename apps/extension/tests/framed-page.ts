import { panelClosedMessage } from "@/messaging/frame-protocol";

/** A dashboard frame stand-in whose parent, the site, is this test page. */
export function framedPage() {
  return Object.assign(new EventTarget(), {
    parent: window,
    document,
    location: { ancestorOrigins: [location.origin], search: "" },
  }) as unknown as Window;
}

/** What the site's content script would send the frame once the PiP window closes. */
export const closePanel = (page: Window) =>
  page.dispatchEvent(
    new MessageEvent("message", {
      data: panelClosedMessage(),
      origin: location.origin,
      source: window,
    }),
  );

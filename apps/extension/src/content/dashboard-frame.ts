import * as v from "valibot";
import { LocationMessageSchema, routeMessage } from "@/messaging/frame-protocol";

const currentPath = (location: Location) => location.pathname + location.search + location.hash;

function coverViewport(iframe: HTMLIFrameElement): void {
  // CSSOM writes are not inline style attributes, so the page's `style-src 'self'` allows them.
  Object.assign(iframe.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    border: "0",
    zIndex: "2147483647",
    background: "Canvas",
  });
}

/** Covers the site with the extension's dashboard and keeps its route in sync with the tab. */
export function mountDashboardFrame(
  dashboardUrl: string,
  extensionOrigin: string,
  page: Window = window,
): void {
  const { document, history, location } = page;
  const iframe = document.createElement("iframe");
  iframe.title = "RECnRun dashboard";
  iframe.src = `${dashboardUrl}?route=${encodeURIComponent(currentPath(location))}`;
  coverViewport(iframe);
  document.documentElement.style.overflow = "hidden";
  document.body.append(iframe);

  page.addEventListener("message", (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== extensionOrigin) return;
    const parsed = v.safeParse(LocationMessageSchema, event.data);
    if (!parsed.success) return;
    if (parsed.output.path !== currentPath(location)) {
      history.pushState(null, "", parsed.output.path);
    }
    document.title = parsed.output.title;
  });
  page.addEventListener("popstate", () => {
    iframe.contentWindow?.postMessage(routeMessage(currentPath(location)), extensionOrigin);
  });
}

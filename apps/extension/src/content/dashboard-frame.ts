import { subscribeFrame } from "@/messaging/frame-channel";
import { routeMessage } from "@/messaging/frame-protocol";

const currentPath = (location: Location) => location.pathname + location.search + location.hash;

export function coverViewport(element: HTMLElement): void {
  // CSSOM writes are not inline style attributes, so the page's `style-src 'self'` allows them.
  Object.assign(element.style, {
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
): HTMLIFrameElement {
  const { document, history, location } = page;
  const iframe = document.createElement("iframe");
  iframe.title = "RECnRun dashboard";
  iframe.src = `${dashboardUrl}?route=${encodeURIComponent(currentPath(location))}`;
  coverViewport(iframe);
  document.documentElement.style.overflow = "hidden";
  document.body.append(iframe);

  subscribeFrame(page, iframe.contentWindow, extensionOrigin, {
    navigate({ path }) {
      if (path !== currentPath(location)) history.pushState(null, "", path);
    },
    // A location for a route the address bar has moved past, by Back or Forward, is stale.
    location({ path, title }) {
      if (path === currentPath(location)) document.title = title;
    },
  });
  page.addEventListener("popstate", () => {
    iframe.contentWindow?.postMessage(routeMessage(currentPath(location)), extensionOrigin);
  });
  return iframe;
}

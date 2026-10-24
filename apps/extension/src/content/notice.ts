import { coverViewport } from "@/content/dashboard-frame";

export const INCOGNITO_NOTICE =
  "RECnRun opens from a normal window. Open recnrun.com there to record incognito tabs.";
export const ORPHANED_NOTICE = "RECnRun was reloaded or turned off. Reload this page to use it.";

/** Covers the site with `text`, where the dashboard cannot show. */
export function showNotice(text: string, page: Window = window): void {
  const { document } = page;
  const notice = document.createElement("p");
  notice.setAttribute("role", "status");
  notice.textContent = text;
  coverViewport(notice);
  // CSSOM writes, like the frame's, which the site's `style-src 'self'` allows.
  Object.assign(notice.style, {
    margin: "0",
    display: "grid",
    placeItems: "center",
    padding: "1rem",
    textAlign: "center",
    color: "CanvasText",
    font: "inherit",
  });
  document.body.append(notice);
}

import { coverViewport } from "@/content/dashboard-frame";

const NOTICE =
  "RECnRun opens from a normal window. Open recnrun.com there to record incognito tabs.";

/** Covers the site in an incognito tab, where the dashboard cannot load, with where to go instead. */
export function showIncognitoNotice(page: Window = window): void {
  const { document } = page;
  const notice = document.createElement("p");
  notice.setAttribute("role", "status");
  notice.textContent = NOTICE;
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

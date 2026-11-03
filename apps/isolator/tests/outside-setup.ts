import type { TargetInfo } from "@/background/probes/types";

export const OUTSIDE = "https://example.com";
export const OUTSIDE_TAB = 9;
export const REFUSED = "refused: not on the loopback";

/** The armed tab's page on the loopback; a test sets its `url` to navigate it away. */
export function loopbackTab(tabId: number, url: string): TargetInfo {
  return { type: "page", id: "page", url, attached: false, tabId };
}

/** `page`, a tab of a site outside the loopback, and that site's service worker. */
export function withOutside(page: TargetInfo): TargetInfo[] {
  return [
    page,
    { type: "page", id: "outside", url: `${OUTSIDE}/`, attached: false, tabId: OUTSIDE_TAB },
    { type: "service_worker", id: "outside-sw", url: `${OUTSIDE}/sw.js`, attached: false },
  ];
}

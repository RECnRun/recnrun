import { browser } from "wxt/browser";

const OPEN_DASHBOARD = { type: "openDashboard" } as const;

/**
 * POC: sends the site visitor to the extension dashboard. `?redirect=tabs` asks the
 * background (tabs.update); `?redirect=replace` navigates from the content script.
 */
export function startRedirect(): void {
  const [navigation] = performance.getEntriesByType("navigation");
  // Back from the dashboard must stay on the site, or the Back button traps the user.
  if ((navigation as PerformanceNavigationTiming | undefined)?.type === "back_forward") return;
  const mode = new URLSearchParams(window.location.search).get("redirect");
  if (mode === "tabs") void browser.runtime.sendMessage(OPEN_DASHBOARD);
  if (mode === "replace") window.location.replace(browser.runtime.getURL("/dashboard.html"));
}

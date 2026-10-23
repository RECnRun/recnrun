import type { Page } from "@playwright/test";
import { expect } from "./extension.ts";
import type { Manifest, ManifestPatch } from "./extension.ts";

export const dashboardUrl = (extensionId: string) =>
  `chrome-extension://${extensionId}/dashboard.html`;

function siteMatches(manifest: Manifest): string[] {
  const scripts = manifest.content_scripts as { matches: string[] }[];
  return [...new Set(scripts.flatMap((script) => script.matches))];
}

/** Lists dashboard.html as web accessible to the same origins the content scripts run on. */
export const dashboardAccessible: ManifestPatch = (manifest) => {
  manifest.web_accessible_resources = [
    { resources: ["dashboard.html"], matches: siteMatches(manifest) },
  ];
};

export const declarativeRedirect =
  (accessible: boolean): ManifestPatch =>
  (manifest) => {
    manifest.permissions = [...(manifest.permissions as string[]), "declarativeNetRequest"];
    manifest.host_permissions = siteMatches(manifest);
    if (accessible) dashboardAccessible(manifest);
  };

export interface NavigationLog {
  committed: { url: string; ms: number }[];
  failed: string[];
  console: string[];
}

/** Records main-frame commits (ms since tracking began), failed requests, and console output. */
export function trackNavigations(page: Page): NavigationLog {
  const start = Date.now();
  const log: NavigationLog = { committed: [], failed: [], console: [] };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      log.committed.push({ url: frame.url(), ms: Date.now() - start });
  });
  page.on("requestfailed", (request) => {
    log.failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("console", (message) => log.console.push(message.text()));
  return log;
}

/** Chrome refuses a page-initiated load of an extension page that is not web accessible. */
export async function expectBlocked(page: Page, log: NavigationLog): Promise<string> {
  // Chrome hides the real URL behind chrome-extension://invalid/ on its error page.
  await expect(page).toHaveURL("chrome-error://chromewebdata/");
  await expect(page).toHaveTitle("chrome-extension://invalid/");
  await expect(page.locator("body")).toContainText("ERR_BLOCKED_BY_CLIENT");
  const body = await page.locator("body").innerText();
  return `url=${page.url()} title=${await page.title()} body=${JSON.stringify(body)} log=${JSON.stringify(log)}`;
}

export async function expectDashboard(page: Page, extensionId: string): Promise<void> {
  await expect(page).toHaveURL(dashboardUrl(extensionId));
  await expect(page.getByRole("heading", { name: "RECnRun dashboard" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("2 recordings");
}

/** Waits long enough for a redirect that would bounce, then checks that none happened. */
export async function expectToStay(page: Page, url: string): Promise<void> {
  await expect(page).toHaveURL(url);
  // Proving the absence of a redirect needs a fixed wait.
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(url);
}

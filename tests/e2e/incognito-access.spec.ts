import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { clickInDashboard, dashboardOf, FRAME, openSite, tabItem } from "./fixtures/session.ts";
import { chromeTabs } from "./fixtures/tabs.ts";

const banner = (site: Page) =>
  dashboardOf(site).getByRole("region", { name: "Enable Incognito Mode" });
const newWindow = (site: Page) =>
  dashboardOf(site).getByRole("button", { name: "New incognito window" });

/** Flips "Allow in Incognito" in RECnRun's details as the user would; Chrome reloads RECnRun. */
async function toggleIncognito(details: Page) {
  await details.bringToFront();
  await details.locator("#allow-incognito").click();
}

/**
 * Returns to a site tab that the reload orphaned. Playwright keeps every tab visible and focused,
 * so it fires the event Chrome fires when the user switches back to the tab.
 */
async function comeBack(site: Page) {
  await expect(site.locator(FRAME)).toHaveCount(0);
  await site.bringToFront();
  await site.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test("without incognito access, the banner opens RECnRun's details, and every site tab follows the toggle", async ({
  context,
  serviceWorker,
}) => {
  const id = new URL(serviceWorker.url()).host;
  const sites = [await openSite(context, "/"), await openSite(context, "/recordings")];
  for (const site of sites) {
    await expect(banner(site)).toContainText(
      "Open the extension settings and enable “Allow in Incognito”.",
    );
    await expect(newWindow(site)).toHaveCount(0);
  }
  const [first, second] = sites;
  await expect(
    tabItem(dashboardOf(first), second.url()).getByRole("button", { name: "Record" }),
  ).toBeVisible();

  const [details] = await Promise.all([
    context.waitForEvent("page"),
    clickInDashboard(banner(first).getByRole("button", { name: "Open Extension Config" })),
  ]);
  await expect(details).toHaveURL(`chrome://extensions/?id=${id}`);
  const tabs = await chromeTabs(serviceWorker);
  expect(tabs.find((tab) => tab.url === details.url())?.active).toBe(true);
  await expect(details.locator("#allow-incognito")).toContainText("Allow in Incognito");
  // Without Developer mode, Chromium disables an unpacked extension when the toggle reloads it.
  await details.locator("#devMode").click();

  await toggleIncognito(details);
  for (const site of sites) {
    await comeBack(site);
    await expect(newWindow(site)).toBeVisible();
    await expect(banner(site)).toHaveCount(0);
  }

  await toggleIncognito(details);
  for (const site of sites) {
    await comeBack(site);
    await expect(banner(site)).toBeVisible();
    await expect(newWindow(site)).toHaveCount(0);
  }
});

test.describe("with incognito access", () => {
  test.use({ incognitoAccess: true });

  test("no banner shows", async ({ context }) => {
    const site = await openSite(context, "/");
    await expect(newWindow(site)).toBeVisible();
    await expect(banner(site)).toHaveCount(0);
  });
});

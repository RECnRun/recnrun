import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { openDashboard } from "./fixtures/session.ts";
import { chromeTabs, installedDashboard } from "./fixtures/tabs.ts";

const banner = (dashboard: Page) =>
  dashboard.getByRole("region", { name: "Enable Incognito Mode" });
const newWindow = (dashboard: Page) =>
  dashboard.getByRole("button", { name: "New incognito window" });

/**
 * Flips "Allow in Incognito" in RECnRun's details as the user would. Chrome reloads RECnRun, which
 * closes the open dashboard and opens one again.
 */
async function toggleIncognito(
  context: BrowserContext,
  serviceWorker: Worker,
  details: Page,
  open: Page,
): Promise<Page> {
  await details.bringToFront();
  await details.locator("#allow-incognito").click();
  await expect.poll(() => open.isClosed()).toBe(true);
  return installedDashboard(context, serviceWorker);
}

test("without incognito access, the banner opens RECnRun's details, and the dashboard follows the toggle", async ({
  context,
  serviceWorker,
}) => {
  const id = new URL(serviceWorker.url()).host;
  const dashboard = await installedDashboard(context, serviceWorker);
  await expect(banner(dashboard)).toContainText(
    "Open the extension settings and enable “Allow in Incognito”.",
  );
  await expect(newWindow(dashboard)).toHaveCount(0);

  const [details] = await Promise.all([
    context.waitForEvent("page"),
    banner(dashboard).getByRole("button", { name: "Open Extension Config" }).click(),
  ]);
  await expect(details).toHaveURL(`chrome://extensions/?id=${id}`);
  const tabs = await chromeTabs(serviceWorker);
  expect(tabs.find((tab) => tab.url === details.url())?.active).toBe(true);
  await expect(details.locator("#allow-incognito")).toContainText("Allow in Incognito");
  // Without Developer mode, Chromium disables an unpacked extension when the toggle reloads it.
  await details.locator("#devMode").click();

  const allowed = await toggleIncognito(context, serviceWorker, details, dashboard);
  await expect(newWindow(allowed)).toBeVisible();
  await expect(banner(allowed)).toHaveCount(0);

  const denied = await toggleIncognito(context, serviceWorker, details, allowed);
  await expect(banner(denied)).toBeVisible();
  await expect(newWindow(denied)).toHaveCount(0);
});

test.describe("with incognito access", () => {
  test.use({ incognitoAccess: true });

  test("no banner shows", async ({ context, serviceWorker }) => {
    const dashboard = await openDashboard(context, serviceWorker);
    await expect(newWindow(dashboard)).toBeVisible();
    await expect(banner(dashboard)).toHaveCount(0);
  });
});

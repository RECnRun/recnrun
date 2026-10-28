import type { BrowserContext, Worker } from "@playwright/test";
import { blockedLoads, expect, test } from "./fixtures/extension.ts";
import { activeTabId } from "./fixtures/session.ts";
import { chromeTabs, dashboardUrl, installedDashboard } from "./fixtures/tabs.ts";

/** The ids of the dashboard tabs open now, as Chrome lists them. */
async function dashboardIds(serviceWorker: Worker) {
  const url = dashboardUrl(serviceWorker);
  return (await chromeTabs(serviceWorker)).filter((tab) => tab.url === url).map((tab) => tab.id);
}

async function closeDashboard(context: BrowserContext, serviceWorker: Worker) {
  await (await installedDashboard(context, serviceWorker)).close();
  await expect.poll(() => dashboardIds(serviceWorker)).toEqual([]);
}

test("the site's root brings the open dashboard forward as it loads", async ({
  context,
  serviceWorker,
}) => {
  await installedDashboard(context, serviceWorker);
  const [dashboard] = await dashboardIds(serviceWorker);
  const site = await context.newPage();
  await site.goto("/");

  await expect.poll(() => activeTabId(serviceWorker)).toBe(dashboard);
  expect(await dashboardIds(serviceWorker)).toEqual([dashboard]);
});

test("with no dashboard open, the site's root opens one in focus", async ({
  context,
  serviceWorker,
}) => {
  await closeDashboard(context, serviceWorker);
  const site = await context.newPage();
  await site.goto("/");

  await expect.poll(async () => (await dashboardIds(serviceWorker)).length).toBe(1);
  const [opened] = await dashboardIds(serviceWorker);
  await expect.poll(() => activeTabId(serviceWorker)).toBe(opened);
});

test("the privacy policy never opens the dashboard", async ({ context, serviceWorker }) => {
  await closeDashboard(context, serviceWorker);
  const privacy = await context.newPage();
  await privacy.goto("/privacy/");
  await expect(privacy.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
  // Give a request the time it would take to arrive.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await dashboardIds(serviceWorker)).toEqual([]);
});

test("Open dashboard on the site brings it back after it was closed", async ({
  context,
  serviceWorker,
}) => {
  const site = await context.newPage();
  const blocked = blockedLoads(site);
  await site.goto("/");
  await expect(site.getByTestId("extension-version")).toHaveText("Extension 0.1.0");
  await expect(site.getByRole("region", { name: "Install the RECnRun extension" })).toHaveCount(0);
  await expect.poll(async () => (await dashboardIds(serviceWorker)).length).toBe(1);
  await closeDashboard(context, serviceWorker);

  await site.getByRole("button", { name: "Open dashboard" }).click();
  await expect.poll(async () => (await dashboardIds(serviceWorker)).length).toBe(1);
  expect(blocked).toEqual([]);
});

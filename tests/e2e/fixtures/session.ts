import type { BrowserContext, Locator, Page, Worker } from "@playwright/test";
import { expect } from "./extension.ts";
import { chromeTabs, dashboardUrl } from "./tabs.ts";

export const FLOATING = "The session floats in its own window.";

/** The recording panel the dashboard renders into its PiP window. */
export const panelIn = (pip: Page) => pip.getByRole("region", { name: "Recording panel" });

export const tabItem = (dashboard: Page, url: string) =>
  dashboard
    .getByRole("complementary", { name: "Tabs" })
    .getByRole("listitem")
    .filter({ hasText: url });

/** A dashboard tab of its own, at the route in `hash`, so each one's row has a distinct address. */
export async function openDashboard(
  context: BrowserContext,
  serviceWorker: Worker,
  hash = "#/",
): Promise<Page> {
  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl(serviceWorker, hash));
  await expect(dashboard.getByRole("heading", { name: "Tabs" })).toBeVisible();
  return dashboard;
}

/** The PiP window is a page of its own in Playwright; this waits for the one a click opens. */
export async function clickToOpenPanel(context: BrowserContext, button: Locator): Promise<Page> {
  const [pip] = await Promise.all([context.waitForEvent("page"), button.click()]);
  return pip;
}

/** Playwright emulates focus, so Chrome's active tab is read from the service worker. */
export const activeTabId = async (serviceWorker: Worker) =>
  (await chromeTabs(serviceWorker)).find((tab) => tab.active)?.id;

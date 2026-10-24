import type { BrowserContext, FrameLocator, Locator, Page, Worker } from "@playwright/test";
import { expect } from "./extension.ts";
import { chromeTabs } from "./tabs.ts";

export const FRAME = 'iframe[title="RECnRun dashboard"]';
export const SESSION_FRAME = 'iframe[title="RECnRun session"]';
export const FLOATING = "The session floats in its own window.";

export const dashboardOf = (site: Page) => site.locator(FRAME).contentFrame();

/** The recording panel of the session page that a PiP window frames. */
export const panelIn = (pip: Page) =>
  pip.locator(SESSION_FRAME).contentFrame().getByRole("region", { name: "Recording panel" });

export const tabItem = (dashboard: FrameLocator, url: string) =>
  dashboard
    .getByRole("complementary", { name: "Tabs" })
    .getByRole("listitem")
    .filter({ hasText: url });

/** A site tab, at its own path so each dashboard's own row has a distinct address. */
export async function openSite(context: BrowserContext, path: string): Promise<Page> {
  const site = await context.newPage();
  await site.goto(path);
  await expect(dashboardOf(site).getByRole("heading", { name: "Tabs" })).toBeVisible();
  return site;
}

/** The PiP window is a page of its own in Playwright; this waits for the one a click opens. */
export async function clickToOpenPanel(context: BrowserContext, button: Locator): Promise<Page> {
  const [pip] = await Promise.all([context.waitForEvent("page"), button.click()]);
  return pip;
}

/** Playwright emulates focus, so Chrome's active tab is read from the service worker. */
export const activeTabId = async (serviceWorker: Worker) =>
  (await chromeTabs(serviceWorker)).find((tab) => tab.active)?.id;

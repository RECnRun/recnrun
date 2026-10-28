import type { BrowserContext, FrameLocator, Locator, Page, Worker } from "@playwright/test";
import { expect } from "./extension.ts";
import { chromeTabs, dashboardUrl } from "./tabs.ts";

export const FRAME = 'iframe[title="RECnRun dashboard"]';
export const FLOATING = "The session floats in its own window.";

export const dashboardOf = (site: Page) => site.locator(FRAME).contentFrame();

/** The recording panel the dashboard renders into its PiP window. */
export const panelIn = (pip: Page) => pip.getByRole("region", { name: "Recording panel" });

export const tabItem = (dashboard: Page | FrameLocator, url: string) =>
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

/**
 * Clicks inside the dashboard frame. Until Chromium publishes that out-of-process frame's hit-test
 * data, it routes a click there to the site; a real pointer moves first, so this waits until a
 * mouse move reaches the element.
 */
export async function clickInDashboard(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("The element to click has no box.");
  let reached = false;
  void target
    .evaluate(
      (element) =>
        new Promise<void>((resolve) => element.addEventListener("mousemove", () => resolve())),
    )
    .then(() => (reached = true));
  let step = 0;
  await expect
    .poll(async () => {
      // Alternating by a pixel makes each move a real one, which fires mousemove.
      step++;
      await target.page().mouse.move(box.x + box.width / 2 + (step % 2), box.y + box.height / 2);
      return reached;
    })
    .toBe(true);
  await target.click();
}

/** The PiP window is a page of its own in Playwright; this waits for the one a click opens. */
export async function clickToOpenPanel(context: BrowserContext, button: Locator): Promise<Page> {
  const [pip] = await Promise.all([context.waitForEvent("page"), button.click()]);
  return pip;
}

/** Playwright emulates focus, so Chrome's active tab is read from the service worker. */
export const activeTabId = async (serviceWorker: Worker) =>
  (await chromeTabs(serviceWorker)).find((tab) => tab.active)?.id;

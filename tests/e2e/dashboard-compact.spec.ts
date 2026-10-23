import type { Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { dashboardUrl, sessionUrl } from "./fixtures/tabs.ts";

// The smallest Split View panes Chrome 156 allowed by dragging the divider, in CSS pixels.
const NARROWEST = { width: 140, height: 700 };
const SHORTEST = { width: 800, height: 64 };

interface ChromeGlobal {
  chrome: { storage: { session: { set(items: object): Promise<void> } } };
}

// clientWidth leaves out a vertical scrollbar, which takes room unless the system overlays it.
const horizontalOverflow = (page: Page) =>
  page.evaluate(() => {
    const { scrollWidth, clientWidth } = document.documentElement;
    return scrollWidth - clientWidth;
  });

/** A session in progress on some tab, as a trigger would store it. */
const startRecording = (serviceWorker: Worker) =>
  serviceWorker.evaluate(
    (recording) =>
      (globalThis as unknown as ChromeGlobal).chrome.storage.session.set({ recording }),
    { tabId: 1, status: "recording", banked: 0, since: Date.now() },
  );

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

test("fits the dashboard in the narrowest split without scrolling sideways", async ({
  page,
  serviceWorker,
}) => {
  await page.setViewportSize(NARROWEST);
  await page.goto(dashboardUrl(serviceWorker));
  await expect(page.getByRole("article").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Record" }).first()).toBeVisible();

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("shows the brand and the tabs in the shortest split", async ({ page, serviceWorker }) => {
  await page.setViewportSize(SHORTEST);
  await page.goto(dashboardUrl(serviceWorker));
  const tabs = page.getByRole("heading", { level: 2, name: "Tabs" });
  await expect(tabs).toBeVisible();

  const brand = await page.getByRole("heading", { level: 1 }).boundingBox();
  const heading = await tabs.boundingBox();
  expect(brand && brand.y + brand.height).toBeLessThanOrEqual(SHORTEST.height);
  expect(heading && heading.y + heading.height).toBeLessThanOrEqual(SHORTEST.height);
});

for (const [split, size] of [
  ["narrowest", NARROWEST],
  ["shortest", SHORTEST],
] as const) {
  test(`fits the session's controls in the ${split} split`, async ({ page, serviceWorker }) => {
    await startRecording(serviceWorker);
    await page.setViewportSize(size);
    await page.goto(sessionUrl(serviceWorker));
    const stop = page.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const box = await stop.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box && box.y + box.height).toBeLessThanOrEqual(size.height);
  });
}

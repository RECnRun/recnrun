import type { Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

// The smallest Split View panes Chrome 156 allowed by dragging the divider, in CSS pixels.
const NARROWEST = { width: 140, height: 700 };
const SHORTEST = { width: 800, height: 64 };

const dashboardUrl = (serviceWorker: Worker, workspace?: string) => {
  const url = new URL("dashboard.html", serviceWorker.url());
  if (workspace !== undefined) url.searchParams.set("workspace", workspace);
  return url.href;
};

// clientWidth leaves out a vertical scrollbar, which takes room unless the system overlays it.
const horizontalOverflow = (page: Page) =>
  page.evaluate(() => {
    const { scrollWidth, clientWidth } = document.documentElement;
    return scrollWidth - clientWidth;
  });

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

for (const [view, workspace] of [
  ["every workspace", undefined],
  ["a workspace with recordings", "https://staging.shop.example"],
  ["an empty workspace", "https://login-acc.example.be"],
] as const) {
  test(`fits ${view} in the narrowest split without scrolling sideways`, async ({
    page,
    serviceWorker,
  }) => {
    await page.setViewportSize(NARROWEST);
    await page.goto(dashboardUrl(serviceWorker, workspace));
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test("shows the brand and the workspace in the shortest split", async ({ page, serviceWorker }) => {
  await page.setViewportSize(SHORTEST);
  await page.goto(dashboardUrl(serviceWorker, "https://staging.shop.example"));
  const workspace = page.getByRole("heading", { level: 2, name: "staging.shop.example" });
  await expect(workspace).toBeVisible();

  const brand = await page.getByRole("heading", { level: 1 }).boundingBox();
  const heading = await workspace.boundingBox();
  expect(brand && brand.y + brand.height).toBeLessThanOrEqual(SHORTEST.height);
  expect(heading && heading.y + heading.height).toBeLessThanOrEqual(SHORTEST.height);
});

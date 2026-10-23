import type { Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

const FRAME = 'iframe[title="RECnRun dashboard"]';

const extensionOrigin = (worker: Worker) => `chrome-extension://${new URL(worker.url()).host}`;

/** Keeps the console lines that report a blocked load or a CSP violation. */
function blockedLoads(page: Page): string[] {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Denying load|ERR_BLOCKED/i.test(message.text())) {
      blocked.push(message.text());
    }
  });
  return blocked;
}

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

test("covers the site with the extension dashboard", async ({ page, serviceWorker }) => {
  const blocked = blockedLoads(page);
  await page.goto("/");
  const frame = page.locator(FRAME);
  await expect(frame.contentFrame().getByRole("article")).toHaveCount(2);
  await expect(frame).toHaveAttribute(
    "src",
    `${extensionOrigin(serviceWorker)}/dashboard.html?route=%2F`,
  );
  expect(await frame.boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize() });
  await expect(page).toHaveTitle("RECnRun");
  await expect(page.getByRole("region", { name: "Install the RECnRun extension" })).toHaveCount(0);
  await expect(page.getByTestId("extension-version")).toHaveText("Extension 0.1.0");
  expect(blocked).toEqual([]);
});

test("keeps the dashboard document out of the site's reach", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(FRAME).contentFrame().getByRole("article")).toHaveCount(2);

  const access = await page.evaluate((selector) => {
    const iframe = document.querySelector<HTMLIFrameElement>(selector);
    try {
      void iframe?.contentWindow?.document.body;
      return { contentDocument: iframe?.contentDocument ?? null, error: "none" };
    } catch (caught) {
      return { contentDocument: iframe?.contentDocument ?? null, error: (caught as Error).name };
    }
  }, FRAME);
  expect(access).toEqual({ contentDocument: null, error: "SecurityError" });
});

test("routes deep links into the dashboard and its navigation to the address bar", async ({
  baseURL,
  page,
}) => {
  await page.goto("/recordings/rec-login");
  const dashboard = page.locator(FRAME).contentFrame();
  await expect(dashboard.getByRole("article")).toHaveAccessibleName("Log in as admin");
  await expect(page).toHaveTitle("Log in as admin · RECnRun");

  await dashboard.getByRole("link", { name: "All recordings" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  const checkout = dashboard.getByRole("link", { name: "Checkout with saved card" });
  await expect(checkout).toHaveAttribute("href", `${baseURL}/recordings/rec-checkout`);
  await checkout.click();
  await expect(page).toHaveURL(`${baseURL}/recordings/rec-checkout`);
  await expect(page).toHaveTitle("Checkout with saved card · RECnRun");

  await page.goBack();
  await expect(dashboard.getByRole("article")).toHaveCount(2);
  await page.goBack();
  await expect(dashboard.getByRole("article")).toHaveAccessibleName("Log in as admin");
  await page.reload();
  await expect(page.locator(FRAME).contentFrame().getByRole("article")).toHaveAccessibleName(
    "Log in as admin",
  );
});

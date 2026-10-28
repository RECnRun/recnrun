import type { Worker } from "@playwright/test";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { blockedLoads, expect, test } from "./fixtures/extension.ts";
import { clickInDashboard, FRAME } from "./fixtures/session.ts";

const extensionOrigin = (worker: Worker) => `chrome-extension://${new URL(worker.url()).host}`;

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

  await clickInDashboard(dashboard.getByRole("link", { name: "All recordings" }));
  await expect(page).toHaveURL(`${baseURL}/`);
  const checkout = dashboard.getByRole("link", { name: "Checkout with saved card" });
  await expect(checkout).toHaveAttribute("href", `${baseURL}/recordings/rec-checkout`);
  await clickInDashboard(checkout);
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

test("opened on its own, session.html points to the site", async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(`${extensionOrigin(serviceWorker)}/session.html`);
  await expect(page.getByRole("status")).toHaveText("Open recnrun.com to use RECnRun.");
  await expect(page.getByRole("article")).toHaveCount(0);
});

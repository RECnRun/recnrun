import type { Page } from "@playwright/test";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "./fixtures/extension.ts";
import { activeTabId, FLOATING } from "./fixtures/session.ts";
import {
  dashboardUrl,
  installedDashboard,
  recordedTabId,
  storedSession,
  tabIdOf,
} from "./fixtures/tabs.ts";

// The privacy policy has no dashboard frame, so it stands in for the user's own application.
const APP = "/privacy/";

const tabRow = (dashboard: Page, url: string) =>
  dashboard
    .getByRole("complementary", { name: "Tabs" })
    .getByRole("listitem")
    .filter({ hasText: url });

const panelIn = (pip: Page) => pip.getByRole("region", { name: "Recording panel" });

test.beforeEach(async ({ page, seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
  await page.goto(APP);
});

test("the dashboard tab keeps its route in the hash through clicks, reloads, and Back", async ({
  context,
  serviceWorker,
}) => {
  const dashboard = await installedDashboard(context, serviceWorker);
  await dashboard.goto(dashboardUrl(serviceWorker, "#/recordings/rec-login"));
  await expect(dashboard.getByRole("heading", { name: "Log in as admin" })).toBeVisible();
  await expect(dashboard).toHaveTitle("Log in as admin · RECnRun");

  await dashboard.getByRole("link", { name: /All recordings/ }).click();
  await expect(dashboard).toHaveURL(dashboardUrl(serviceWorker, "#/"));
  await dashboard.getByRole("link", { name: "Checkout with saved card" }).click();
  await expect(dashboard).toHaveURL(dashboardUrl(serviceWorker, "#/recordings/rec-checkout"));
  await dashboard.reload();
  await expect(dashboard).toHaveTitle("Checkout with saved card · RECnRun");

  await dashboard.goBack();
  await expect(dashboard).toHaveTitle("RECnRun");
  await expect(dashboard.getByRole("article")).toHaveCount(2);
});

test("Record on the dashboard tab floats the session, and Stop returns to the tab", async ({
  context,
  page,
  serviceWorker,
}) => {
  const dashboard = await installedDashboard(context, serviceWorker);
  const record = tabRow(dashboard, page.url()).getByRole("button", { name: "Record" });
  const [pip] = await Promise.all([context.waitForEvent("page"), record.click()]);

  await expect(panelIn(pip)).toContainText("Recording");
  const logo = panelIn(pip).getByRole("img", { name: "RECnRun" });
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  expect(await recordedTabId(serviceWorker)).toBe(await tabIdOf(serviceWorker, page.url()));
  await expect(tabRow(dashboard, page.url())).toContainText(FLOATING);

  await panelIn(pip).getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
  expect(await recordedTabId(serviceWorker)).toBeNull();
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, dashboard.url()));
});

test("closing the dashboard tab's PiP window keeps the session and gives the control back", async ({
  context,
  page,
  serviceWorker,
}) => {
  const dashboard = await installedDashboard(context, serviceWorker);
  const row = tabRow(dashboard, page.url());
  const [pip] = await Promise.all([
    context.waitForEvent("page"),
    row.getByRole("button", { name: "Record" }).click(),
  ]);
  await expect(panelIn(pip)).toContainText("Recording");
  const started = await storedSession(serviceWorker);

  await pip.close();
  await expect(row.getByRole("button")).toHaveText(["Continue", "Stop"]);
  expect(await storedSession(serviceWorker)).toEqual(started);
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, dashboard.url()));
});

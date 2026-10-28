import type { Snapshot } from "@recnrun/domain";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { blockedLoads, expect, test } from "./fixtures/extension.ts";
import { dashboardUrl, installedDashboard } from "./fixtures/tabs.ts";

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
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

test("the dashboard tab shows the stored recordings, and loads nothing it is denied", async ({
  context,
  serviceWorker,
}) => {
  const dashboard = await context.newPage();
  const blocked = blockedLoads(dashboard);
  await dashboard.goto(dashboardUrl(serviceWorker));
  const recordings = dashboard.getByRole("article");
  await expect(recordings).toHaveCount(2);
  await expect(recordings.first()).toHaveAccessibleName("Checkout with saved card");
  await expect(recordings.first()).toContainText("https://staging.shop.example/cart");
  await expect(recordings.first()).toContainText("31 events");
  await expect(dashboard.getByRole("article", { name: "Log in as admin" })).toContainText("12 s");
  await expect(dashboard).toHaveTitle("RECnRun");
  expect(blocked).toEqual([]);
});

test("the dashboard tab explains an empty extension and unreadable data", async ({
  context,
  seedSnapshot,
  serviceWorker,
}) => {
  await seedSnapshot({ ...sampleSnapshot(), recordings: [] });
  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl(serviceWorker));
  await expect(dashboard.getByRole("heading", { name: "No recordings yet" })).toBeVisible();

  await seedSnapshot({ schemaVersion: 99 } as unknown as Snapshot);
  await dashboard.reload();
  await expect(dashboard.getByRole("heading", { name: "Could not read your data" })).toBeVisible();
});

test("the dashboard tab asks to pin RECnRun while its icon is off the toolbar", async ({
  context,
  serviceWorker,
}) => {
  // Nothing pins an extension for the user, so the test browser starts with it off the toolbar.
  const settings = await serviceWorker.evaluate(() =>
    (
      globalThis as unknown as { chrome: { action: { getUserSettings(): Promise<unknown> } } }
    ).chrome.action.getUserSettings(),
  );
  expect(settings).toEqual({ isOnToolbar: false });
  const dashboard = await installedDashboard(context, serviceWorker);
  const hint = dashboard.getByRole("region", { name: "Pin RECnRun to the toolbar" });
  await expect(hint).toContainText("Extensions menu");
});

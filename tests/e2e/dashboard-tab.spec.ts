import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../packages/domain/src/index.ts";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  dashboardPages,
  dashboardUrl,
  openDashboardFromBackground,
  sessionSplit,
  tabIdOf,
} from "./fixtures/tabs.ts";

const manifestPath = fileURLToPath(
  new URL("../../apps/extension/.output/chrome-mv3-test/manifest.json", import.meta.url),
);

interface ChromeGlobal {
  chrome: {
    commands: { getAll(): Promise<{ name?: string; shortcut?: string }[]> };
    contextMenus: { update(id: string, properties: object): Promise<void> };
  };
}

test("lists the stored recordings, newest first, on the dashboard page", async ({
  context,
  serviceWorker,
  seedSnapshot,
}) => {
  await seedSnapshot(sampleSnapshot());
  const page = await context.newPage();
  await page.goto(dashboardUrl(serviceWorker));

  const recordings = page.getByRole("article");
  await expect(recordings).toHaveCount(2);
  await expect(recordings.first()).toHaveAccessibleName("Checkout with saved card");
  await expect(recordings.first()).toContainText("https://staging.shop.example/cart");
  await expect(recordings.first()).toContainText("31 events");
  await expect(page.getByRole("article", { name: "Log in as admin" })).toContainText("12 s");
});

test("explains an empty extension and unreadable data", async ({
  context,
  serviceWorker,
  seedSnapshot,
}) => {
  const page = await context.newPage();
  await page.goto(dashboardUrl(serviceWorker));
  await expect(page.getByRole("heading", { name: "No recordings yet" })).toBeVisible();

  await seedSnapshot({ schemaVersion: 99 } as unknown as Snapshot);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Could not read your data" })).toBeVisible();
});

test("keeps the open recording in the address bar hash", async ({
  context,
  serviceWorker,
  seedSnapshot,
}) => {
  await seedSnapshot(sampleSnapshot());
  const page = await context.newPage();
  await page.goto(`${dashboardUrl(serviceWorker)}#/recordings/rec-login`);
  await expect(page.getByRole("article")).toHaveAccessibleName("Log in as admin");
  await expect(page).toHaveTitle("Log in as admin · RECnRun");

  await page.getByRole("link", { name: "All recordings" }).click();
  await page.getByRole("link", { name: "Checkout with saved card" }).click();
  await expect(page).toHaveURL(`${dashboardUrl(serviceWorker)}#/recordings/rec-checkout`);
  await expect(page).toHaveTitle("Checkout with saved card · RECnRun");

  await page.goBack();
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page).toHaveTitle("RECnRun");
});

test("every dashboard trigger opens another dashboard tab", async ({ context, serviceWorker }) => {
  await openDashboardFromBackground(serviceWorker);
  await openDashboardFromBackground(serviceWorker);
  await expect.poll(() => dashboardPages(context, serviceWorker).length).toBe(2);
});

test("lists the browser's tabs and records one with the session split beside it", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/recordings/rec-login");
  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl(serviceWorker));
  const tabs = dashboard.getByRole("complementary", { name: "Tabs" });
  const site = tabs.getByRole("listitem").filter({ hasText: page.url() });
  await expect(site).toBeVisible();

  await site.getByRole("button", { name: "Record" }).click();
  await expect
    .poll(async () => (await sessionSplit(serviceWorker)).partner?.id)
    .toBe(await tabIdOf(serviceWorker, page.url()));
  await expect(site).toContainText(/Recording \d\d:\d\d/);
  await expect(site.getByRole("button")).toHaveText(["Show", "Pause", "Stop"]);
  const self = tabs.getByRole("listitem").filter({ hasText: dashboardUrl(serviceWorker) });
  await expect(self.getByRole("button")).toHaveCount(0);

  await site.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => (await sessionSplit(serviceWorker)).pane).toBeUndefined();
  await expect(self.getByRole("button", { name: "Record" })).toBeVisible();
});

test("a dashboard tab can be the recorded tab itself", async ({ context, serviceWorker }) => {
  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl(serviceWorker));
  const self = dashboard
    .getByRole("complementary", { name: "Tabs" })
    .getByRole("listitem")
    .filter({ hasText: dashboardUrl(serviceWorker) });
  await self.getByRole("button", { name: "Record" }).click();
  await expect
    .poll(async () => (await sessionSplit(serviceWorker)).partner?.id)
    .toBe(await tabIdOf(serviceWorker, dashboard.url()));
  await expect(self.getByRole("button")).toHaveText(["Show", "Pause", "Stop"]);
});

test("registers the keyboard commands and the context menu items", async ({ serviceWorker }) => {
  const commands = await serviceWorker.evaluate(() =>
    (globalThis as unknown as ChromeGlobal).chrome.commands.getAll(),
  );
  expect(commands).toContainEqual(
    expect.objectContaining({ name: "open-session", shortcut: "Alt+Shift+S" }),
  );
  expect(commands).toContainEqual(
    expect.objectContaining({ name: "open-dashboard", shortcut: "Alt+Shift+D" }),
  );
  // update() rejects for an id that was never created, so it proves the item exists.
  for (const id of ["open-dashboard", "open-recnrun"]) {
    await expect
      .poll(() =>
        serviceWorker.evaluate(
          (item) =>
            (globalThis as unknown as ChromeGlobal).chrome.contextMenus.update(item, {}).then(
              () => "registered",
              (error: unknown) => String(error),
            ),
          id,
        ),
      )
      .toBe("registered");
  }
});

test("declares a toolbar action without a popup, so a click opens the session", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.action).toBeDefined();
  expect(manifest.action.default_popup).toBeUndefined();
  expect(manifest.commands["open-session"].suggested_key).toEqual({
    default: "Alt+Shift+S",
    mac: "MacCtrl+Shift+S",
  });
  expect(manifest.commands["open-dashboard"].suggested_key).toEqual({
    default: "Alt+Shift+D",
    mac: "MacCtrl+Shift+D",
  });
});

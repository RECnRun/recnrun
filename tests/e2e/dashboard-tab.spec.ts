import type { BrowserContext, Worker } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../packages/domain/src/index.ts";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

const manifestPath = fileURLToPath(
  new URL("../../apps/extension/.output/chrome-mv3-test/manifest.json", import.meta.url),
);

interface ChromeGlobal {
  chrome: {
    runtime: { getURL(path: string): string };
    tabs: { query(filter: { url: string }): Promise<{ active: boolean }[]> };
    commands: { getAll(): Promise<{ name?: string; shortcut?: string }[]> };
    contextMenus: { update(id: string, properties: object): Promise<void> };
  };
  // Exposed by the service worker in test builds only.
  recnrunOpenDashboard?: () => Promise<void>;
}

const dashboardUrl = (serviceWorker: Worker) => new URL("dashboard.html", serviceWorker.url()).href;

function dashboardPages(context: BrowserContext, serviceWorker: Worker) {
  return context.pages().filter((page) => page.url().startsWith(dashboardUrl(serviceWorker)));
}

/** Playwright emulates focus, so every page reports "visible"; Chrome's tab state is the truth. */
function dashboardTabsActive(serviceWorker: Worker): Promise<boolean[]> {
  return serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("dashboard.html") });
    return tabs.map((tab) => tab.active);
  });
}

function openDashboardFromBackground(serviceWorker: Worker): Promise<void> {
  return serviceWorker.evaluate(async () => {
    const open = (globalThis as unknown as ChromeGlobal).recnrunOpenDashboard;
    if (!open) throw new Error("The service worker does not expose openDashboard.");
    await open();
  });
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

test("opens one dashboard tab and focuses it instead of duplicating", async ({
  context,
  serviceWorker,
}) => {
  await openDashboardFromBackground(serviceWorker);
  await expect.poll(() => dashboardPages(context, serviceWorker).length).toBe(1);

  const other = await context.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await expect.poll(() => dashboardTabsActive(serviceWorker)).toEqual([false]);

  await openDashboardFromBackground(serviceWorker);
  await expect.poll(() => dashboardTabsActive(serviceWorker)).toEqual([true]);
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
});

test("registers the keyboard command and the toolbar context menu item", async ({
  serviceWorker,
}) => {
  const commands = await serviceWorker.evaluate(() =>
    (globalThis as unknown as ChromeGlobal).chrome.commands.getAll(),
  );
  expect(commands).toContainEqual(
    expect.objectContaining({ name: "open-dashboard", shortcut: "Alt+Shift+D" }),
  );
  // update() rejects for an id that was never created, so it proves the item exists.
  await expect
    .poll(() =>
      serviceWorker.evaluate(() =>
        (globalThis as unknown as ChromeGlobal).chrome.contextMenus
          .update("open-dashboard", {})
          .then(
            () => "registered",
            (error: unknown) => String(error),
          ),
      ),
    )
    .toBe("registered");
});

test("declares a toolbar action without a popup, so a click opens the dashboard", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.action).toBeDefined();
  expect(manifest.action.default_popup).toBeUndefined();
  expect(manifest.commands["open-dashboard"].suggested_key).toEqual({
    default: "Alt+Shift+D",
    mac: "MacCtrl+Shift+D",
  });
});

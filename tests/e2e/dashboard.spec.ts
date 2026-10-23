import type { BrowserContext, Worker } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

const manifestPath = fileURLToPath(
  new URL("../../apps/extension/.output/chrome-mv3-test/manifest.json", import.meta.url),
);

interface ChromeGlobal {
  chrome: {
    runtime: { getURL(path: string): string };
    tabs: { query(filter: { url: string }): Promise<{ id?: number; active: boolean }[]> };
    commands: { getAll(): Promise<{ name?: string; shortcut?: string }[]> };
    contextMenus: { update(id: string, properties: object): Promise<void> };
  };
  // Exposed by the service worker in test builds only.
  recnrunOpenDashboard?: () => Promise<void>;
}

function dashboardUrl(serviceWorker: Worker): string {
  return new URL("dashboard.html", serviceWorker.url()).href;
}

function dashboardPages(context: BrowserContext, serviceWorker: Worker) {
  return context.pages().filter((page) => page.url() === dashboardUrl(serviceWorker));
}

/** Playwright emulates focus, so every page reports "visible"; Chrome's tab state is the truth. */
async function dashboardTabsActive(serviceWorker: Worker): Promise<boolean[]> {
  return serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("dashboard.html") });
    return tabs.map((tab) => tab.active);
  });
}

async function openDashboardFromBackground(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(async () => {
    const open = (globalThis as unknown as ChromeGlobal).recnrunOpenDashboard;
    if (!open) throw new Error("The service worker does not expose openDashboard.");
    await open();
  });
}

test("lists the stored recordings on the extension dashboard page", async ({
  context,
  serviceWorker,
  seedSnapshot,
}) => {
  await seedSnapshot(sampleSnapshot());
  const page = await context.newPage();
  await page.goto(dashboardUrl(serviceWorker));

  await expect(page.getByRole("heading", { name: "RECnRun", level: 1 })).toBeVisible();
  const checkout = page.getByRole("article", { name: "Checkout with saved card" });
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(checkout).toContainText("https://staging.shop.example/cart");
  await expect(checkout).toContainText("31 events");
});

test("opens one dashboard tab and focuses it instead of duplicating", async ({
  context,
  serviceWorker,
}) => {
  await openDashboardFromBackground(serviceWorker);
  await expect.poll(() => dashboardPages(context, serviceWorker).length).toBe(1);
  const [dashboard] = dashboardPages(context, serviceWorker);
  if (!dashboard) throw new Error("The dashboard tab did not open.");
  await expect(dashboard.getByRole("heading", { name: "RECnRun", level: 1 })).toBeVisible();

  const other = await context.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await expect.poll(() => dashboardTabsActive(serviceWorker)).toEqual([false]);

  await openDashboardFromBackground(serviceWorker);
  await expect.poll(() => dashboardTabsActive(serviceWorker)).toEqual([true]);
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
});

test("finds its own dashboard tab by URL without the tabs permission", async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.goto(dashboardUrl(serviceWorker));
  const matches = await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return (await chrome.tabs.query({ url: chrome.runtime.getURL("dashboard.html") })).length;
  });
  expect(matches).toBe(1);
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

test("declares a popup-less action, the command, and only storage and contextMenus", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.permissions).toEqual(["storage", "contextMenus"]);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.action).toBeDefined();
  expect(manifest.action.default_popup).toBeUndefined();
  expect(manifest.commands["open-dashboard"].suggested_key).toEqual({
    default: "Alt+Shift+D",
    mac: "MacCtrl+Shift+D",
  });
});

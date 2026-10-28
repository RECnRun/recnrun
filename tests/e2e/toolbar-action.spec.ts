import type { BrowserContext, Worker } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/extension.ts";
import { activeTabId } from "./fixtures/session.ts";
import { dashboardUrl, focusTab, recordedTabId, tabIdOf } from "./fixtures/tabs.ts";

test.use({ remoteDebuggingPort: 9333 });

const manifestPath = fileURLToPath(
  new URL("../../apps/extension/.output/chrome-mv3-test/manifest.json", import.meta.url),
);

interface ChromeGlobal {
  chrome: { commands?: { getAll(): Promise<{ name?: string; shortcut?: string }[]> } } & Record<
    string,
    unknown
  >;
}

/** The dashboard tabs open now, as Chrome lists them. */
async function dashboards(context: BrowserContext, serviceWorker: Worker) {
  const url = dashboardUrl(serviceWorker);
  return context.pages().filter((each) => each.url().startsWith(url));
}

test("the toolbar icon brings the open dashboard forward instead of opening another", async ({
  context,
  page,
  serviceWorker,
  clickToolbarIcon,
}) => {
  await page.goto("/privacy/");
  await expect.poll(async () => (await dashboards(context, serviceWorker)).length).toBe(1);
  await focusTab(serviceWorker, (await tabIdOf(serviceWorker, page.url())) ?? -1);
  const [dashboard] = await dashboards(context, serviceWorker);
  await clickToolbarIcon(page);

  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, dashboard?.url() ?? ""));
  expect(await dashboards(context, serviceWorker)).toHaveLength(1);
  expect(await recordedTabId(serviceWorker)).toBeNull();
});

test("with no dashboard open, the toolbar icon opens one in focus", async ({
  context,
  page,
  serviceWorker,
  clickToolbarIcon,
}) => {
  await page.goto("/privacy/");
  await expect.poll(async () => (await dashboards(context, serviceWorker)).length).toBe(1);
  for (const each of await dashboards(context, serviceWorker)) await each.close();
  const [opened] = await Promise.all([context.waitForEvent("page"), clickToolbarIcon(page)]);

  await expect(opened.getByRole("heading", { name: "Tabs" })).toBeVisible();
  expect(opened.url()).toBe(dashboardUrl(serviceWorker));
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, opened.url()));
});

test("the extension has no popup, keyboard commands, or context menu", async ({
  serviceWorker,
}) => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.action).toBeDefined();
  expect(manifest.action.default_popup).toBeUndefined();
  expect(manifest.commands).toBeUndefined();
  // The test build adds offscreen for the cross-profile POC; the production guard allows none.
  expect(manifest.permissions).toEqual(["storage", "tabs", "offscreen"]);

  const surface = await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    // Chrome leaves out the commands API when the manifest declares none.
    const commands = (await chrome.commands?.getAll()) ?? [];
    return { shortcuts: commands.filter((each) => each.shortcut), menus: "contextMenus" in chrome };
  });
  expect(surface).toEqual({ shortcuts: [], menus: false });
});

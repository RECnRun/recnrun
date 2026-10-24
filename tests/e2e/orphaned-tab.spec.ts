import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { dashboardOf, FRAME, openSite, tabItem } from "./fixtures/session.ts";

const NOTICE = "RECnRun was reloaded or turned off. Reload this page to use it.";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

interface ExtensionsPage {
  chrome: { management: { setEnabled(id: string, enabled: boolean): Promise<void> } };
}

/** Turns RECnRun off from chrome://extensions, which leaves the site's content script orphaned. */
async function turnOff(extensions: Page, id: string) {
  await extensions.goto("chrome://extensions");
  await extensions.evaluate(
    (extensionId) =>
      (globalThis as unknown as ExtensionsPage).chrome.management.setEnabled(extensionId, false),
    id,
  );
}

test("a site tab left behind by turning RECnRun off says to reload", async ({
  context,
  serviceWorker,
}) => {
  const site = await openSite(context, "/");
  await turnOff(await context.newPage(), new URL(serviceWorker.url()).host);

  await expect(site.getByRole("status").filter({ hasText: NOTICE })).toBeVisible();
  await expect(site.locator(FRAME)).toHaveCount(0);
});

test("a site tab showing the dashboard when RECnRun reloads says to reload, and opens no PiP window", async ({
  context,
  serviceWorker,
}) => {
  const site = await openSite(context, "/");
  const pages = context.pages().length;
  await serviceWorker.evaluate(() =>
    (globalThis as unknown as { chrome: { runtime: { reload(): void } } }).chrome.runtime.reload(),
  );

  await expect(site.getByRole("status").filter({ hasText: NOTICE })).toBeVisible();
  await expect(site.locator(FRAME)).toHaveCount(0);
  expect(context.pages()).toHaveLength(pages);
});

test.describe("with a DevTools port", () => {
  test.use({ remoteDebuggingPort: 9334 });

  test("a site tab keeps its dashboard while RECnRun stays loaded, its service worker stopped", async ({
    context,
    remoteDebuggingPort,
  }) => {
    const site = await openSite(context, "/");
    const other = await openSite(context, "/recordings");
    await other.close();
    // Chrome stops an idle service worker after 30 seconds; the site's port must outlive it.
    const remote = await chromium.connectOverCDP(`http://127.0.0.1:${remoteDebuggingPort}`);
    const cdp = await remote.newBrowserCDPSession();
    const workers = async () =>
      ((await cdp.send("Target.getTargets")) as { targetInfos: TargetInfo[] }).targetInfos.filter(
        ({ type, url }) => type === "service_worker" && url.startsWith("chrome-extension://"),
      );
    for (const { targetId } of await workers()) await cdp.send("Target.closeTarget", { targetId });
    await expect.poll(async () => (await workers()).length).toBe(0);
    await remote.close();

    await expect(
      tabItem(dashboardOf(site), site.url()).getByRole("button", { name: "Record" }),
    ).toBeVisible();
    await expect(site.getByRole("status").filter({ hasText: NOTICE })).toHaveCount(0);
  });
});

import { chromium } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "./fixtures/extension.ts";
import { clickToOpenPanel, panelIn, tabItem } from "./fixtures/session.ts";
import { chromeTabs, dashboardUrl, installedDashboard, recordedTabId } from "./fixtures/tabs.ts";

// The privacy policy runs no RECnRun script, so it stands in for the user's own application.
const APP = "/privacy/";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

interface ExtensionsPage {
  chrome: { management: { setEnabled(id: string, enabled: boolean): Promise<void> } };
}

/** Turns RECnRun off from chrome://extensions, as the user would. */
async function turnOff(extensions: Page, id: string) {
  await extensions.goto("chrome://extensions");
  await extensions.evaluate(
    (extensionId) =>
      (globalThis as unknown as ExtensionsPage).chrome.management.setEnabled(extensionId, false),
    id,
  );
}

/** The pages that are not RECnRun's own. */
function otherPages(context: BrowserContext, serviceWorker: Worker) {
  const extension = new URL("/", serviceWorker.url()).href;
  return context.pages().filter((each) => !each.url().startsWith(extension));
}

test("turning RECnRun off closes its dashboard and leaves every other tab alone", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto(APP);
  const site = await context.newPage();
  await site.goto("/");
  await expect(site.getByRole("button", { name: "Open dashboard" })).toBeVisible();
  const dashboard = await installedDashboard(context, serviceWorker);
  const before = otherPages(context, serviceWorker).length;
  await turnOff(await context.newPage(), new URL(serviceWorker.url()).host);

  await expect.poll(() => dashboard.isClosed()).toBe(true);
  expect(otherPages(context, serviceWorker)).toHaveLength(before + 1);
  await expect(page.getByRole("heading", { name: "Privacy policy" })).toBeVisible();
  // The site keeps its docs, with nothing over them.
  await expect(site.getByRole("button", { name: "Open dashboard" })).toBeVisible();
  await expect(site.getByRole("status")).toHaveCount(0);
});

test("a reload of RECnRun closes its dashboard and opens a fresh one", async ({
  context,
  serviceWorker,
}) => {
  const dashboard = await installedDashboard(context, serviceWorker);
  const extensions = await context.newPage();
  await extensions.goto("chrome://extensions");
  // Without Developer mode, Chromium disables an unpacked extension when it reloads.
  await extensions.locator("#devMode").click();
  await serviceWorker.evaluate(() =>
    (globalThis as unknown as { chrome: { runtime: { reload(): void } } }).chrome.runtime.reload(),
  );

  await expect.poll(() => dashboard.isClosed()).toBe(true);
  const reopened = await installedDashboard(context, serviceWorker);
  await expect(reopened.getByRole("heading", { name: "Tabs" })).toBeVisible();
});

test.describe("with a DevTools port", () => {
  test.use({ remoteDebuggingPort: 9334 });

  test("a dashboard records once its service worker has stopped", async ({
    context,
    page,
    remoteDebuggingPort,
    seedSnapshot,
    serviceWorker,
  }) => {
    await seedSnapshot(sampleSnapshot());
    await page.goto(APP);
    const dashboard = await installedDashboard(context, serviceWorker);
    // Chrome stops an idle service worker after 30 seconds; the dashboard must wake it.
    const remote = await chromium.connectOverCDP(`http://127.0.0.1:${remoteDebuggingPort}`);
    const cdp = await remote.newBrowserCDPSession();
    const workers = async () =>
      ((await cdp.send("Target.getTargets")) as { targetInfos: TargetInfo[] }).targetInfos.filter(
        ({ type, url }) => type === "service_worker" && url.startsWith("chrome-extension://"),
      );
    for (const { targetId } of await workers()) await cdp.send("Target.closeTarget", { targetId });
    await expect.poll(async () => (await workers()).length).toBe(0);
    await remote.close();

    const record = tabItem(dashboard, page.url()).getByRole("button", { name: "Record" });
    const pip = await clickToOpenPanel(context, record);
    await expect(panelIn(pip)).toContainText("Recording");
    const woken = context.serviceWorkers().at(-1) ?? serviceWorker;
    await expect.poll(() => recordedTabId(woken)).not.toBeNull();
    expect((await chromeTabs(woken)).some((tab) => tab.url === dashboardUrl(woken))).toBe(true);
  });
});

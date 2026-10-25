import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import {
  clickInDashboard,
  clickToOpenPanel,
  dashboardOf,
  openSite,
  SESSION_FRAME,
  tabItem,
} from "./fixtures/session.ts";
import {
  chromeTabs,
  focusTab,
  openIncognitoTab,
  recordedTabId,
  storedText,
  tabIdOf,
} from "./fixtures/tabs.ts";

const tabsOf = (site: Page) => dashboardOf(site).getByRole("complementary", { name: "Tabs" });

/** The incognito control sits above the tab list, so it is found in the dashboard, not the list. */
const incognitoWindowButton = (site: Page) =>
  dashboardOf(site).getByRole("button", { name: "New incognito window" });

/** What the session page in the PiP window shows of a tab: the current one, or the recorded one. */
const tabRegion = (pip: Page, name: "Current tab" | "Recorded tab") =>
  pip.locator(SESSION_FRAME).contentFrame().getByRole("region", { name });

/** The Playwright page of the tab Chrome opened at `url`, incognito ones included. */
async function pageAt(context: BrowserContext, url: string): Promise<Page> {
  await expect.poll(() => context.pages().some((each) => each.url() === url)).toBe(true);
  const found = context.pages().find((each) => each.url() === url);
  if (!found) throw new Error(`No page shows ${url}.`);
  return found;
}

async function idOf(serviceWorker: Worker, url: string): Promise<number> {
  const id = await tabIdOf(serviceWorker, url);
  if (id === undefined) throw new Error(`No tab shows ${url}.`);
  return id;
}

test.describe("without incognito access", () => {
  test("lists the normal tabs and says how to allow incognito ones", async ({ context }) => {
    const site = await openSite(context, "/");
    await expect(dashboardOf(site).locator("body")).toContainText("Allow in Incognito");
    await expect(incognitoWindowButton(site)).toHaveCount(0);
    await expect(tabItem(dashboardOf(site), site.url())).not.toContainText("Incognito");
  });
});

test.describe("with incognito access", () => {
  test.use({ incognitoAccess: true });

  test("a new incognito window from the dashboard lists its tab, ready to record", async ({
    context,
    serviceWorker,
  }) => {
    const site = await openSite(context, "/");
    await expect(dashboardOf(site).locator("body")).not.toContainText("Allow in Incognito");
    await clickInDashboard(incognitoWindowButton(site));

    await expect
      .poll(async () => (await chromeTabs(serviceWorker)).filter((tab) => tab.incognito).length)
      .toBe(1);
    const incognito = tabsOf(site).getByRole("listitem").filter({ hasText: "Incognito" });
    await expect(incognito).toHaveCount(1);
    await expect(incognito.getByRole("button")).toHaveText(["Record"]);
    expect(await recordedTabId(serviceWorker)).toBeNull();
  });

  test("records an incognito tab, and the PiP window follows the current tab", async ({
    baseURL,
    context,
    serviceWorker,
  }) => {
    const privateUrl = `${baseURL}/privacy/?private`;
    await openIncognitoTab(serviceWorker, privateUrl);
    const privatePage = await pageAt(context, privateUrl);
    const site = await openSite(context, "/");
    const row = tabItem(dashboardOf(site), privateUrl);
    await expect(row).toContainText("Incognito");

    const pip = await clickToOpenPanel(context, row.getByRole("button", { name: "Record" }));
    const privateId = await idOf(serviceWorker, privateUrl);
    expect(await recordedTabId(serviceWorker)).toBe(privateId);
    const current = tabRegion(pip, "Current tab");
    await expect(current).toContainText("Privacy policy · RECnRun");
    await expect(current).toContainText(privateUrl);
    await expect(current).toContainText("Incognito");
    await expect(current).toContainText("Recorded");
    await expect(tabRegion(pip, "Recorded tab")).toHaveCount(0);

    const otherUrl = `${baseURL}/privacy/?elsewhere`;
    await privatePage.goto(otherUrl);
    await expect(current).toContainText(otherUrl);

    await focusTab(serviceWorker, await idOf(serviceWorker, site.url()));
    await expect(current).toContainText(site.url());
    await expect(current).not.toContainText("Incognito");
    await expect(tabRegion(pip, "Recorded tab")).toContainText(otherUrl);
    await expect(tabRegion(pip, "Recorded tab")).toContainText("Incognito");
    expect(await recordedTabId(serviceWorker)).toBe(privateId);

    expect(await storedText(serviceWorker)).not.toMatch(/private|elsewhere/);
  });

  test("an incognito site tab points to a normal window", async ({
    baseURL,
    context,
    serviceWorker,
  }) => {
    await openIncognitoTab(serviceWorker, `${baseURL}/`);
    const privateSite = await pageAt(context, `${baseURL}/`);
    await expect(privateSite.getByRole("status").last()).toHaveText(
      "RECnRun opens from a normal window. Open recnrun.com there to record incognito tabs.",
    );
    await expect(privateSite.locator('iframe[title="RECnRun dashboard"]')).toHaveCount(0);
  });
});

test("the PiP window tells the current tab from the recorded one, and drops closed tabs", async ({
  baseURL,
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/privacy/?recorded");
  const site = await openSite(context, "/");
  const pip = await clickToOpenPanel(
    context,
    tabItem(dashboardOf(site), page.url()).getByRole("button", { name: "Record" }),
  );
  const current = tabRegion(pip, "Current tab");
  await expect(current).toContainText(page.url());
  await expect(current).toContainText("Recorded");

  const other = await context.newPage();
  await other.goto("/privacy/?other");
  await focusTab(serviceWorker, await idOf(serviceWorker, other.url()));
  await expect(current).toContainText(`${baseURL}/privacy/?other`);
  await expect(current).not.toContainText("Recorded");
  await expect(tabRegion(pip, "Recorded tab")).toContainText(page.url());

  await focusTab(serviceWorker, await idOf(serviceWorker, page.url()));
  await expect(current).toContainText(page.url());
  await expect(tabRegion(pip, "Recorded tab")).toHaveCount(0);

  await focusTab(serviceWorker, await idOf(serviceWorker, other.url()));
  await expect(current).toContainText("?other");
  await other.close();
  await expect(current).not.toContainText("?other");

  await page.close();
  await expect(tabRegion(pip, "Recorded tab")).toContainText("The recorded tab was closed.");
  await expect(current).not.toContainText("?recorded");
});

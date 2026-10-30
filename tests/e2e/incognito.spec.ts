import type { Page, Worker } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import {
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
import {
  APP,
  openWorkspaceApp,
  pageAt,
  startWorkspace,
  workspacePanel,
} from "./fixtures/workspace.ts";

const tabsOf = (site: Page) => dashboardOf(site).getByRole("complementary", { name: "Tabs" });

/** What the session page in the PiP window shows of a tab: the current one, or the recorded one. */
const tabRegion = (pip: Page, name: "Current tab" | "Recorded tab") =>
  pip.locator(SESSION_FRAME).contentFrame().getByRole("region", { name });

async function idOf(serviceWorker: Worker, url: string): Promise<number> {
  const id = await tabIdOf(serviceWorker, url);
  if (id === undefined) throw new Error(`No tab shows ${url}.`);
  return id;
}

test.describe("without incognito access", () => {
  test("lists the normal tabs and says how to allow incognito ones", async ({ context }) => {
    const site = await openSite(context, "/");
    await expect(dashboardOf(site).locator("body")).toContainText("Allow in Incognito");
    await expect(
      workspacePanel(site).getByRole("button", { name: "New identity", exact: true }),
    ).toHaveCount(0);
    await expect(tabItem(dashboardOf(site), site.url())).not.toContainText("Incognito");
  });
});

test.describe("with incognito access", () => {
  test.use({ incognitoAccess: true });

  test("every Incognito tab of the open identity offers Record, never a normal tab", async ({
    context,
    serviceWorker,
  }) => {
    const site = await openSite(context, "/");
    await expect(dashboardOf(site).locator("body")).not.toContainText("Allow in Incognito");
    await startWorkspace(site, serviceWorker, `${APP}/inspect?run=listed`);

    await expect
      .poll(async () => (await chromeTabs(serviceWorker)).filter((tab) => tab.incognito).length)
      .toBe(1);
    const incognito = tabsOf(site).getByRole("listitem").filter({ hasText: "Incognito" });
    await expect(incognito).toHaveCount(1);
    await expect(incognito.getByRole("button")).toHaveText(["Record"]);
    expect(await recordedTabId(serviceWorker)).toBeNull();

    const normal = tabItem(dashboardOf(site), site.url());
    await expect(normal).toBeVisible();
    await expect(normal.getByRole("button")).toHaveCount(0);
    // A window opened while the identity is open is its session too, so its tab records.
    const besideUrl = `${APP}/inspect?run=beside`;
    await openIncognitoTab(serviceWorker, besideUrl);
    const beside = tabItem(dashboardOf(site), besideUrl);
    await expect(beside).toContainText("Incognito");
    await expect(beside.getByRole("button")).toHaveText(["Record"]);
    await site.screenshot({ path: test.info().outputPath("record-session-tabs.png") });
  });

  test("records the managed tab, and the PiP window follows the current tab", async ({
    context,
    serviceWorker,
  }) => {
    const privateUrl = `${APP}/inspect?run=private`;
    const site = await openSite(context, "/");
    const app = await openWorkspaceApp(site, serviceWorker, privateUrl);
    const row = tabItem(dashboardOf(site), privateUrl);
    await expect(row).toContainText("Incognito");

    const pip = await clickToOpenPanel(context, row.getByRole("button", { name: "Record" }));
    expect(await recordedTabId(serviceWorker)).toBe(app.id);
    const current = tabRegion(pip, "Current tab");
    await expect(current).toContainText("Inspect");
    await expect(current).toContainText(privateUrl);
    await expect(current).toContainText("Incognito");
    await expect(current).toContainText("Recorded");
    await expect(tabRegion(pip, "Recorded tab")).toHaveCount(0);

    const otherUrl = `${APP}/inspect?run=elsewhere`;
    await app.page.goto(otherUrl);
    await expect(current).toContainText(otherUrl);

    await focusTab(serviceWorker, await idOf(serviceWorker, site.url()));
    await expect(current).toContainText(site.url());
    await expect(current).not.toContainText("Incognito");
    await expect(tabRegion(pip, "Recorded tab")).toContainText(otherUrl);
    await expect(tabRegion(pip, "Recorded tab")).toContainText("Incognito");
    expect(await recordedTabId(serviceWorker)).toBe(app.id);

    const { local, session } = JSON.parse(await storedText(serviceWorker)) as {
      local: { identities?: { url: string }[] };
      session: unknown;
    };
    // The identity keeps the address the user typed to open it; nothing keeps what the tab showed.
    expect(local.identities?.map(({ url }) => url)).toEqual([privateUrl]);
    const rest = JSON.stringify({ local: { ...local, identities: undefined }, session });
    expect(rest).not.toMatch(/private|elsewhere/);
  });

  test("the PiP window tells the current tab from the recorded one, and drops closed tabs", async ({
    baseURL,
    context,
    serviceWorker,
  }) => {
    const recordedUrl = `${APP}/inspect?run=recorded`;
    const site = await openSite(context, "/");
    const app = await openWorkspaceApp(site, serviceWorker, recordedUrl);
    const pip = await clickToOpenPanel(
      context,
      tabItem(dashboardOf(site), recordedUrl).getByRole("button", { name: "Record" }),
    );
    const current = tabRegion(pip, "Current tab");
    await expect(current).toContainText(recordedUrl);
    await expect(current).toContainText("Recorded");

    const other = await context.newPage();
    await other.goto("/privacy/?other");
    await focusTab(serviceWorker, await idOf(serviceWorker, other.url()));
    await expect(current).toContainText(`${baseURL}/privacy/?other`);
    await expect(current).not.toContainText("Recorded");
    await expect(tabRegion(pip, "Recorded tab")).toContainText(recordedUrl);

    await focusTab(serviceWorker, app.id);
    await expect(current).toContainText(recordedUrl);
    await expect(tabRegion(pip, "Recorded tab")).toHaveCount(0);
    await pip.screenshot({ path: test.info().outputPath("pip-recorded-current.png") });

    await focusTab(serviceWorker, await idOf(serviceWorker, other.url()));
    await expect(current).toContainText("?other");
    await other.close();
    await expect(current).not.toContainText("?other");

    await app.page.close();
    await expect(tabRegion(pip, "Recorded tab")).toContainText("The recorded tab was closed.");
    await expect(current).not.toContainText("run=recorded");
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

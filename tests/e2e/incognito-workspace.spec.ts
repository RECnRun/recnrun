import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { clickInDashboard, dashboardOf, openSite } from "./fixtures/session.ts";
import { chromeTabs, openIncognitoTab } from "./fixtures/tabs.ts";
import {
  APP,
  managedWindow,
  runWorkspace,
  startWorkspace,
  workspacePanel,
} from "./fixtures/workspace.ts";

/** Saves what the dashboard shows next to the test's results, for a person to look at. */
const screen = (site: Page, name: string) =>
  site.screenshot({ path: test.info().outputPath(`${name}.png`) });

const incognitoUrls = async (serviceWorker: Parameters<typeof chromeTabs>[0]) =>
  (await chromeTabs(serviceWorker)).filter((tab) => tab.incognito).map((tab) => tab.url);

test.describe("without incognito access", () => {
  test("the workspace states its requirement and offers no Start", async ({ context }) => {
    const site = await openSite(context, "/");
    const panel = workspacePanel(site);
    await expect(panel).toContainText("The Incognito workspace requires “Allow in Incognito”.");
    await expect(panel.getByRole("button")).toHaveCount(0);
    await expect(
      dashboardOf(site).getByRole("button", { name: "Use this tab's address" }),
    ).toHaveCount(0);
    await screen(site, "no-access");
  });
});

test.describe("with incognito access", () => {
  test.use({ incognitoAccess: true });

  test("Start opens the managed window at the address from a normal tab", async ({
    context,
    serviceWorker,
  }) => {
    const site = await openSite(context, "/");
    const panel = workspacePanel(site);
    await expect(panel.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await expect(
      dashboardOf(site).getByRole("button", { name: "New incognito window" }),
    ).toHaveCount(0);
    await screen(site, "start");

    const tabId = await startWorkspace(site, serviceWorker, `${APP}/inspect?run=start`);
    await expect.poll(() => incognitoUrls(serviceWorker)).toEqual([`${APP}/inspect?run=start`]);
    const tabs = await chromeTabs(serviceWorker);
    expect(tabs.find((tab) => tab.incognito)?.id).toBe(tabId);
    await expect(panel.getByRole("button", { name: "Close and start empty" })).toBeVisible();
    await expect(panel).toContainText("Its current Incognito data is discarded.");
    await screen(site, "open");
  });

  test("open Incognito windows block Start until the user closes them through the panel", async ({
    context,
    serviceWorker,
  }) => {
    await openIncognitoTab(serviceWorker, `${APP}/inspect?run=foreign-a`);
    await openIncognitoTab(serviceWorker, `${APP}/inspect?run=foreign-b`);
    const site = await openSite(context, "/");
    const panel = workspacePanel(site);
    await expect(panel).toContainText("2 Incognito windows are open");
    await expect(panel.getByRole("listitem")).toHaveCount(2);
    await expect(panel.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    await expect(panel).toContainText("Or close them yourself");
    await screen(site, "blocked");

    await runWorkspace(site, `${APP}/inspect?run=closed`, "Close these windows and start");
    await expect(panel).toContainText("Incognito workspace open");
    await expect.poll(() => incognitoUrls(serviceWorker)).toEqual([`${APP}/inspect?run=closed`]);
  });

  test("a window opened after the user looked refreshes the list instead of being closed", async ({
    context,
    serviceWorker,
  }) => {
    await openIncognitoTab(serviceWorker, `${APP}/inspect?run=first`);
    const site = await openSite(context, "/");
    const panel = workspacePanel(site);
    await expect(panel).toContainText("1 Incognito window is open");
    await openIncognitoTab(serviceWorker, `${APP}/inspect?run=second`);
    await expect(panel).toContainText("2 Incognito windows are open");
  });

  test("Close and start empty replaces the managed window with a fresh one", async ({
    context,
    serviceWorker,
  }) => {
    const site = await openSite(context, "/");
    const first = await startWorkspace(site, serviceWorker, `${APP}/inspect?run=one`);
    const before = await managedWindow(serviceWorker);
    await runWorkspace(site, `${APP}/inspect?run=two`, "Close and start empty");
    await expect
      .poll(async () => (await managedWindow(serviceWorker))?.generation)
      .toBe((before?.generation ?? 0) + 1);
    const after = await managedWindow(serviceWorker);
    expect(after?.tabId).not.toBe(first);
    expect(after?.windowId).not.toBe(before?.windowId);
    await expect.poll(() => incognitoUrls(serviceWorker)).toEqual([`${APP}/inspect?run=two`]);
    await expect(workspacePanel(site)).toContainText("Incognito workspace open");
  });

  test("an internal address is refused with the background's reason", async ({ context }) => {
    const site = await openSite(context, "/");
    await runWorkspace(site, "chrome://settings/", "Start");
    await expect(workspacePanel(site).getByRole("alert")).toHaveText(
      "Only http and https pages can open in the Incognito workspace.",
    );
    await screen(site, "refused");
  });

  test("Use this tab's address copies a normal tab's address into the panel", async ({
    context,
    page,
  }) => {
    await page.goto(`${APP}/inspect?run=address`);
    const site = await openSite(context, "/");
    const row = dashboardOf(site)
      .getByRole("complementary", { name: "Tabs" })
      .getByRole("listitem")
      .filter({ hasText: `${APP}/inspect?run=address` });
    await clickInDashboard(row.getByRole("button", { name: "Use this tab's address" }));
    await expect(workspacePanel(site).getByRole("textbox", { name: "Address" })).toHaveValue(
      `${APP}/inspect?run=address`,
    );
    await expect(workspacePanel(site)).toContainText("never its cookies or storage");
    await screen(site, "address");
  });
});

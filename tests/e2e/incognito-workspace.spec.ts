import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { clickInDashboard, dashboardOf, openSite } from "./fixtures/session.ts";
import { chromeTabs, openIncognitoTab } from "./fixtures/tabs.ts";
import {
  APP,
  managedWindow,
  pageAt,
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
  test("the workspace states its requirement and offers no command", async ({ context }) => {
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

  test("New identity opens the managed window at the address, named A", async ({
    context,
    serviceWorker,
  }) => {
    const site = await openSite(context, "/");
    const panel = workspacePanel(site);
    await expect(panel.getByRole("button", { disabled: false })).toHaveText(["New identity"]);
    await expect(
      dashboardOf(site).getByRole("button", { name: "New incognito window" }),
    ).toHaveCount(0);
    await screen(site, "start");

    const tabId = await startWorkspace(site, serviceWorker, `${APP}/inspect?run=start`);
    await expect.poll(() => incognitoUrls(serviceWorker)).toEqual([`${APP}/inspect?run=start`]);
    const tabs = await chromeTabs(serviceWorker);
    expect(tabs.find((tab) => tab.incognito)?.id).toBe(tabId);
    const a = panel.getByRole("listitem").filter({ hasText: "A" });
    await expect(a.getByText("Open", { exact: true })).toBeVisible();
    await expect(a.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
    await screen(site, "open");
  });

  test("open Incognito windows block New identity until Close these windows closes them", async ({
    context,
    serviceWorker,
  }) => {
    await openIncognitoTab(serviceWorker, `${APP}/inspect?run=foreign-a`);
    await openIncognitoTab(serviceWorker, `${APP}/inspect?run=foreign-b`);
    const site = await openSite(context, "/");
    const panel = workspacePanel(site);
    await expect(panel).toContainText("2 Incognito windows are open");
    await expect(panel.locator("ul.incognito-windows").getByRole("listitem")).toHaveCount(2);
    await expect(panel.getByRole("button", { name: "New identity" })).toBeDisabled();
    await expect(panel.getByRole("button", { disabled: false })).toHaveText([
      "Close these windows",
    ]);
    await screen(site, "blocked");

    await clickInDashboard(panel.getByRole("button", { name: "Close these windows" }));
    await expect.poll(() => incognitoUrls(serviceWorker)).toEqual([]);
    await expect(panel.getByRole("button", { name: "New identity" })).toBeEnabled();
    await startWorkspace(site, serviceWorker, `${APP}/inspect?run=closed`);
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

  test("another Incognito window beside the workspace leaves only Close these windows", async ({
    context,
    serviceWorker,
  }) => {
    const site = await openSite(context, "/");
    await startWorkspace(site, serviceWorker, `${APP}/inspect?run=managed`);
    await openIncognitoTab(serviceWorker, `${APP}/inspect?run=beside`);
    const panel = workspacePanel(site);
    await expect(panel).toContainText("1 Incognito window is open");
    // The disabled commands stay in view beside the conflict that explains why.
    await expect(panel.getByRole("button", { disabled: false })).toHaveText([
      "Close these windows",
    ]);
    await expect(panel.getByRole("button", { name: "New identity" })).toBeDisabled();
    await screen(site, "open-and-foreign");

    await (await pageAt(context, `${APP}/inspect?run=beside`)).close();
    await expect(panel.getByRole("button", { name: "New identity" })).toBeEnabled();
    expect((await managedWindow(serviceWorker))?.status).toBe("active");
  });

  test("an internal address is refused with the background's reason", async ({ context }) => {
    const site = await openSite(context, "/");
    await runWorkspace(site, "chrome://settings/", "New identity");
    await expect(workspacePanel(site).getByRole("alert")).toHaveText(
      "New identity failed. Only http and https pages can open in the Incognito workspace.",
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

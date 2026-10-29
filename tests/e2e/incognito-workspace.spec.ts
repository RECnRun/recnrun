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
  test("the workspace states its requirement and offers no command", async ({ context }) => {
    const site = await openSite(context, "/");
    const panel = workspacePanel(site);
    await expect(panel).toContainText("The Incognito workspace requires “Allow in Incognito”.");
    await expect(panel.getByRole("button")).toHaveCount(0);
    await expect(panel.getByRole("combobox", { name: "Address" })).toHaveCount(0);
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

  test("another Incognito window beside the workspace is its session, not a conflict", async ({
    context,
    serviceWorker,
  }) => {
    const site = await openSite(context, "/");
    await startWorkspace(site, serviceWorker, `${APP}/inspect?run=managed`);
    await openIncognitoTab(serviceWorker, `${APP}/inspect?run=beside`);
    const panel = workspacePanel(site);
    await expect.poll(() => incognitoUrls(serviceWorker)).toHaveLength(2);
    await expect(panel.getByRole("button", { name: "New identity" })).toBeEnabled();
    await expect(panel).not.toContainText("Incognito window is open");
    await expect(panel.getByRole("button", { name: "Close these windows" })).toHaveCount(0);
    await screen(site, "open-and-beside");
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

  test("Address suggests a normal tab and a visited page, and New identity opens the pick", async ({
    context,
    page,
    serviceWorker,
  }) => {
    const visited = `${APP}/inspect?run=suggest-visited`;
    const open = `${APP}/inspect?run=suggest-open`;
    await page.goto(visited);
    await page.goto(open);
    const site = await openSite(context, "/");
    const panel = workspacePanel(site);
    const address = panel.getByRole("combobox", { name: "Address" });
    await address.fill("run=suggest");
    const options = panel.getByRole("listbox", { name: "Address suggestions" }).getByRole("option");
    await expect(options.filter({ hasText: open })).toContainText("Open tab");
    await expect(options.filter({ hasText: visited })).toContainText("History");
    await expect(panel).toContainText("never cookies or storage");
    // The open list spans the field's row, so no hint text below it peeks out beside it.
    const listbox = panel.getByRole("listbox", { name: "Address suggestions" });
    const spans = await listbox.evaluate((list) => {
      const box = list.getBoundingClientRect();
      const under = [...document.querySelectorAll(".workspace-hint")]
        .map((hint) => hint.getBoundingClientRect())
        .filter((hint) => hint.top < box.bottom && hint.bottom > box.top);
      return under.map((hint) => box.left <= hint.left && box.right >= hint.right);
    });
    expect(spans.length).toBeGreaterThan(0);
    expect(spans).not.toContain(false);
    await screen(site, "address-suggestions");

    await clickInDashboard(options.filter({ hasText: visited }));
    await expect(address).toHaveValue(visited);
    await expect(options).toHaveCount(0);
    await clickInDashboard(panel.getByRole("button", { name: "New identity", exact: true }));
    await expect.poll(() => incognitoUrls(serviceWorker)).toEqual([visited]);
  });
});

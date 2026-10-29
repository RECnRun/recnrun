import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { clickInDashboard, dashboardOf, openSite } from "./fixtures/session.ts";
import { workspacePanel } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const NOTICE =
  "RECnRun saves every site's cookies with an identity, so it needs Site access “On all sites”.";

/** Sets Site access in RECnRun's details as the user would; Chrome keeps RECnRun running. */
async function siteAccess(details: Page, value: "ON_CLICK" | "ON_ALL_SITES") {
  await details.bringToFront();
  await details.locator("select#hostAccess").selectOption(value);
}

test("withheld Site access hides New identity and leads to RECnRun's details, until granted again", async ({
  context,
  serviceWorker,
}) => {
  const id = new URL(serviceWorker.url()).host;
  const site = await openSite(context, "/");
  const panel = workspacePanel(site);
  const newIdentity = panel.getByRole("button", { name: "New identity", exact: true });
  await expect(newIdentity).toBeEnabled();

  const details = await context.newPage();
  await details.goto(`chrome://extensions/?id=${id}`);
  await siteAccess(details, "ON_CLICK");
  // The details page stays in front: only Chrome's permissions event can bring the change in.
  await expect(panel).toContainText(NOTICE);
  await expect(newIdentity).toHaveCount(0);
  await site.bringToFront();
  await expect(
    dashboardOf(site).getByRole("button", { name: "Use this tab's address" }),
  ).toHaveCount(0);
  await site.screenshot({ path: test.info().outputPath("site-access-withheld.png") });

  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    clickInDashboard(panel.getByRole("button", { name: "Open RECnRun's details" })),
  ]);
  await expect(opened).toHaveURL(`chrome://extensions/?id=${id}`);

  await siteAccess(details, "ON_ALL_SITES");
  await expect(newIdentity).toBeEnabled();
  await expect(panel).not.toContainText(NOTICE);
});

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { clickInDashboard, dashboardOf, openSite } from "./fixtures/session.ts";
import { ssoAppUrl, ssoPage, ssoSettled, ssoSignIn } from "./fixtures/sso.ts";
import { workspacePanel } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Saves what the dashboard shows next to the test's results, for a person to look at. */
const screen = (site: Page, name: string) =>
  site.screenshot({ path: test.info().outputPath(`${name}.png`) });

const identity = (site: Page, label: string) =>
  dashboardOf(site)
    .getByRole("list", { name: "Saved identities" })
    .getByRole("listitem", { name: label, exact: true });

/** Fills the panel's New identity form for the SSO app of `run`. */
async function fillNew(site: Page, run: string, label: string, hosts: string) {
  const panel = workspacePanel(site);
  await panel.getByRole("textbox", { name: "Address" }).fill(ssoAppUrl(run));
  await panel.getByRole("textbox", { name: "Label" }).fill(label);
  await panel.getByRole("textbox", { name: "Cookie hosts" }).fill(hosts);
  return panel.getByRole("button", { name: "New identity", exact: true });
}

test("an identity that declares its provider in the dashboard comes back signed in there", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-dashboard-${Date.now()}`;
  const site = await openSite(context, "/");
  await clickInDashboard(await fillNew(site, run, "A", " SSO.localhost "));
  await expect(workspacePanel(site)).toContainText("Incognito workspace open: A");
  const a = await ssoPage(context);
  // The new identity's silent check settles signed out before the sign-in navigates away.
  expect(await ssoSettled(a)).toMatchObject({ signedIn: null, error: "login_required" });
  expect(await ssoSignIn(a, run, "A")).toMatchObject({ signedIn: "A" });
  await expect(identity(site, "A")).toContainText("Also keeps cookies of sso.localhost");

  await clickInDashboard(await fillNew(site, run, "B", "sso.localhost"));
  await expect(workspacePanel(site)).toContainText("Incognito workspace open: B");
  const b = await ssoPage(context, a);
  expect(await ssoSettled(b)).toMatchObject({ first: { token: null }, signedIn: null });
  expect(await ssoSignIn(b, run, "B")).toMatchObject({ signedIn: "B" });
  await screen(site, "declared-hosts");

  await clickInDashboard(identity(site, "A").getByRole("button", { name: "Switch to" }));
  await expect(workspacePanel(site)).toContainText("Incognito workspace open: A");
  const back = await ssoPage(context, b);
  expect(await ssoSettled(back)).toMatchObject({ first: { token: "A" }, signedIn: "A" });
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

test("the dashboard names a cookie host it cannot use, and the build refuses one it cannot read", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-dashboard-refused-${Date.now()}`;
  const site = await openSite(context, "/");
  const create = await fillNew(site, run, "A", "https://sso.localhost/");
  await expect(workspacePanel(site).getByRole("alert")).toContainText(
    "Cookie hosts are host names, such as sso.example.com.",
  );
  await expect(create).toBeDisabled();
  await screen(site, "host-not-valid");

  await clickInDashboard(await fillNew(site, run, "A", "sso.example.com"));
  await expect(workspacePanel(site).getByRole("alert").first()).toContainText(
    "This build cannot read the cookies of sso.example.com",
  );
  await screen(site, "host-refused");
  expect(await incognitoWindows(serviceWorker)).toBe(0);
  await expect(identity(site, "A")).toHaveCount(0);
});

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { clickInFrame, dashboardOf, openSite } from "./fixtures/session.ts";
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

/** Fills the panel's address with the SSO app of `run` and returns New identity. */
async function fillNew(site: Page, run: string) {
  const panel = workspacePanel(site);
  await panel.getByRole("combobox", { name: "Address" }).fill(ssoAppUrl(run));
  return panel.getByRole("button", { name: "New identity", exact: true });
}

/** `label` is Open and its command returned: Close waits while the command, and the barrier, run. */
async function opened(site: Page, label: string) {
  await expect(identity(site, label).getByText("Open", { exact: true })).toBeVisible();
  await expect(
    identity(site, label).getByRole("button", { name: "Close", exact: true }),
  ).toBeEnabled();
}

test("an identity made in the dashboard comes back signed in at its provider", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-dashboard-${Date.now()}`;
  const site = await openSite(context, "/");
  await clickInFrame(await fillNew(site, run));
  await opened(site, "A");
  const a = await ssoPage(context);
  // The new identity's silent check settles signed out before the sign-in navigates away.
  expect(await ssoSettled(a)).toMatchObject({ signedIn: null, error: "login_required" });
  expect(await ssoSignIn(a, run, "A")).toMatchObject({ signedIn: "A" });

  await clickInFrame(await fillNew(site, run));
  await opened(site, "B");
  const b = await ssoPage(context, a);
  expect(await ssoSettled(b)).toMatchObject({ first: { token: null }, signedIn: null });
  expect(await ssoSignIn(b, run, "B")).toMatchObject({ signedIn: "B" });
  await screen(site, "b-signed-in");

  await clickInFrame(identity(site, "A").getByRole("button", { name: "Switch to" }));
  await opened(site, "A");
  const back = await ssoPage(context, b);
  expect(await ssoSettled(back)).toMatchObject({ first: { token: "A" }, signedIn: "A" });
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

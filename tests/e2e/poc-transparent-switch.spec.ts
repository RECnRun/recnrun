import type { Page, Worker } from "@playwright/test";
import { IDP } from "./apps/sso-pages.ts";
import { expect, test } from "./fixtures/extension.ts";
import { failNext, incognitoWindows, normalCookies, setNormalCookie } from "./fixtures/identity.ts";
import { newIdentity, opened, switchTo, identity } from "./fixtures/panel.ts";
import { clickInDashboard, openSite } from "./fixtures/session.ts";
import {
  expireServerSessions,
  ssoAppUrl,
  ssoPage,
  ssoServerSignIn,
  ssoServerUrl,
  ssoSettled,
  ssoSignIn,
  SIGNED_OUT,
} from "./fixtures/sso.ts";
import { openIncognitoTab } from "./fixtures/tabs.ts";
import { APP, workspacePanel } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true, viewport: { width: 1280, height: 1400 } });

/** Saves what the dashboard shows next to the test's results, for a person to look at. */
const screen = (site: Page, name: string) =>
  site.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** Cookies the normal profile holds for the app and its provider, which no switch may touch. */
async function normalProfile(serviceWorker: Worker) {
  return {
    app: await normalCookies(serviceWorker, `${APP}/`),
    idp: await normalCookies(serviceWorker, `${IDP}/`),
  };
}

async function markNormalProfile(serviceWorker: Worker) {
  await setNormalCookie(serviceWorker, `${APP}/`);
  await setNormalCookie(serviceWorker, `${IDP}/`);
  return normalProfile(serviceWorker);
}

test("A, a new B, and back to A through the panel, each signed in at its provider", async ({
  context,
  serviceWorker,
}) => {
  const run = `transparent-${Date.now()}`;
  const normal = await markNormalProfile(serviceWorker);
  const site = await openSite(context, "/");
  await expect(workspacePanel(site).getByRole("button", { name: "New identity" })).toBeEnabled();
  await screen(site, "1-empty");

  await newIdentity(site, ssoAppUrl(run));
  await opened(site, "A");
  const a = await ssoPage(context);
  expect(await ssoSettled(a)).toMatchObject(SIGNED_OUT);
  expect(await ssoSignIn(a, run, "A")).toMatchObject({ signedIn: "A" });
  await screen(site, "2-a-open");

  await newIdentity(site, ssoAppUrl(run));
  await opened(site, "B");
  const b = await ssoPage(context, a);
  expect(await ssoSettled(b)).toMatchObject({ first: { token: null }, signedIn: null });
  expect(await ssoSignIn(b, run, "B")).toMatchObject({ signedIn: "B" });
  await expect(identity(site, "A")).toContainText(/Saved .+, about \d/);
  await screen(site, "3-b-open-a-saved");

  await switchTo(site, "A");
  await opened(site, "A");
  const backOnA = await ssoPage(context, b);
  // A's sign-in came back silently: the app's first read already held A's token.
  expect(await ssoSettled(backOnA)).toMatchObject({ first: { token: "A" }, signedIn: "A" });
  expect(await incognitoWindows(serviceWorker)).toBe(1);
  await screen(site, "4-back-on-a");

  await switchTo(site, "B");
  await opened(site, "B");
  const backOnB = await ssoPage(context, backOnA);
  expect(await ssoSettled(backOnB)).toMatchObject({ first: { token: "B" }, signedIn: "B" });
  expect(await incognitoWindows(serviceWorker)).toBe(1);
  expect(await normalProfile(serviceWorker)).toEqual(normal);
});

test("a server app whose sessions expired signs A in again through its provider on Switch to", async ({
  context,
  serviceWorker,
}) => {
  const run = `transparent-server-${Date.now()}`;
  const site = await openSite(context, "/");
  await newIdentity(site, ssoServerUrl(run));
  await opened(site, "A");
  const a = await ssoPage(context);
  expect(await ssoSettled(a)).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  expect(await ssoServerSignIn(a, run, "A")).toMatchObject({ signedIn: "A" });

  await newIdentity(site, ssoServerUrl(run));
  await opened(site, "B");
  const b = await ssoPage(context, a);
  expect(await ssoSettled(b)).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  expect(await ssoServerSignIn(b, run, "B")).toMatchObject({ signedIn: "B" });

  await expireServerSessions(run);
  await switchTo(site, "A");
  await opened(site, "A");
  const back = await ssoPage(context, b);
  expect(await ssoSettled(back)).toMatchObject({ signedIn: "A", error: null });
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

test("a failed switch and another Incognito window show in the panel, and the panel recovers", async ({
  context,
  serviceWorker,
}) => {
  const run = `transparent-faults-${Date.now()}`;
  const site = await openSite(context, "/");
  await newIdentity(site, ssoAppUrl(run));
  await opened(site, "A");
  const a = await ssoPage(context);
  expect(await ssoSignIn(a, run, "A")).toMatchObject({ signedIn: "A" });
  await newIdentity(site, ssoAppUrl(run));
  await opened(site, "B");
  const b = await ssoPage(context, a);
  await ssoSettled(b);

  await failNext(serviceWorker, "restore");
  await switchTo(site, "A");
  const alert = workspacePanel(site).getByRole("alert");
  await expect(alert).toHaveText(/^Switch to failed at the restore step\. /);
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  await screen(site, "5-failure");

  await openIncognitoTab(serviceWorker, "about:blank");
  const panel = workspacePanel(site);
  await expect(panel).toContainText("1 Incognito window is open");
  await expect(alert).toHaveCount(1);
  await expect(identity(site, "A").getByRole("button", { name: "Switch to" })).toBeDisabled();
  await screen(site, "6-conflict");

  await clickInDashboard(panel.getByRole("button", { name: "Close these windows" }));
  await expect(alert).toHaveCount(0);
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  await switchTo(site, "A");
  await opened(site, "A");
  const back = await ssoPage(context);
  expect(await ssoSettled(back)).toMatchObject({ first: { token: "A" }, signedIn: "A" });
});

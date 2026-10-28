import type { BrowserContext, Page, Worker } from "@playwright/test";
import { appLog } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { identitiesAt, lifecycleDriver, nextPageAt } from "./fixtures/lifecycle.ts";
import { idpStorage, ssoAppUrl, ssoSettled, ssoSignIn } from "./fixtures/sso.ts";

test.use({ incognitoAccess: true });

const SSO_HOSTS = { cookieHosts: ["sso.localhost"] };
const SIGNED_OUT = { signedIn: null, error: "login_required" };

/** Identities by label at the SSO app of `run`, each declaring `capabilities`. */
async function ssoSetUp(
  context: BrowserContext,
  serviceWorker: Worker,
  run: string,
  capabilities?: { cookieHosts: string[] },
) {
  const url = ssoAppUrl(run);
  const driver = await lifecycleDriver(context, serviceWorker);
  const identities = identitiesAt(driver.command, url, new Map(), capabilities);
  const tab: { page?: Page } = {};
  /** Opens `label` and waits until the app settled on who is signed in. */
  const open = async (label: string) => {
    await identities.open(label);
    tab.page = await nextPageAt(context, url, tab.page);
    return { page: tab.page, state: await ssoSettled(tab.page) };
  };
  return { open, tab };
}

/** The provider's silent checks of `run`, by whether they carried its session cookie. */
const silentChecks = async (run: string) =>
  (await appLog(run))
    .filter(({ path }) => path === "/sso/authorize")
    .map(({ cookies }) => (cookies?.includes("idp_session") ? "session" : "none"));

test("a declared SSO host keeps each identity signed in at its provider through A → B → A → C → A", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-declared-${Date.now()}`;
  const { open } = await ssoSetUp(context, serviceWorker, run, SSO_HOSTS);
  const a = await open("A");
  expect(a.state).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  expect(await ssoSignIn(a.page, run, "A")).toMatchObject({ signedIn: "A" });
  const b = await open("B");
  expect(b.state).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  expect(await ssoSignIn(b.page, run, "B")).toMatchObject({ signedIn: "B" });

  // The app's token comes back from its own storage, the provider's session from the declared host.
  const back = await open("A");
  expect(back.state).toMatchObject({ first: { token: "A" }, signedIn: "A", error: null });
  const c = await open("C");
  expect(c.state).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  const again = await open("A");
  expect(again.state).toMatchObject({ first: { token: "A" }, signedIn: "A" });
  expect(await silentChecks(run)).toEqual(["none", "none", "session", "none", "session"]);

  // Only cookies of a declared host are data: the provider's own localStorage starts empty.
  expect(await idpStorage(again.page)).toEqual({});
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

test("without the declared SSO host, a resumed identity keeps its token but is signed out", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-undeclared-${Date.now()}`;
  const { open } = await ssoSetUp(context, serviceWorker, run);
  await ssoSignIn((await open("A")).page, run, "A");
  await ssoSignIn((await open("B")).page, run, "B");
  const back = await open("A");
  expect(back.state).toMatchObject({ first: { token: "A" }, ...SIGNED_OUT });
  expect(await silentChecks(run)).toEqual(["none", "none", "none"]);
});

import { appLog } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { idpStorage, SIGNED_OUT, ssoAppUrl, ssoSetUp, ssoSignIn } from "./fixtures/sso.ts";

test.use({ incognitoAccess: true });

/** The provider's silent checks of `run`, by whether they carried its session cookie. */
const silentChecks = async (run: string) =>
  (await appLog(run))
    .filter(({ path }) => path === "/sso/authorize")
    .map(({ cookies }) => (cookies?.includes("idp_session") ? "session" : "none"));

test("each identity comes back signed in at its provider through A → B → A → C → A, with nothing declared", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-${Date.now()}`;
  const { open } = await ssoSetUp(context, serviceWorker, ssoAppUrl(run));
  const a = await open("A");
  expect(a.state).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  expect(await ssoSignIn(a.page, run, "A")).toMatchObject({ signedIn: "A" });
  const b = await open("B");
  expect(b.state).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  expect(await ssoSignIn(b.page, run, "B")).toMatchObject({ signedIn: "B" });

  // The app's token comes back from its own storage, the provider's session from the Incognito cookie store.
  const back = await open("A");
  expect(back.state).toMatchObject({ first: { token: "A" }, signedIn: "A", error: null });
  const c = await open("C");
  expect(c.state).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  const again = await open("A");
  expect(again.state).toMatchObject({ first: { token: "A" }, signedIn: "A" });
  expect(await silentChecks(run)).toEqual(["none", "none", "session", "none", "session"]);

  // The provider's origin was visited, so its own storage comes back with A too.
  expect(await idpStorage(again.page)).toEqual({
    localStorage: { idp_user: "A" },
    indexedDB: "A",
  });
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

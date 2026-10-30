import type { Page } from "@playwright/test";
import { IDP } from "./apps/sso-pages.ts";
import { appLog } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows, journalOf } from "./fixtures/identity.ts";
import {
  expireProviderSessions,
  expireServerSessions,
  SIGNED_OUT,
  ssoFormSignIn,
  ssoInteractiveUrl,
  ssoPage,
  ssoServerSignIn,
  ssoServerUrl,
  ssoSetUp,
} from "./fixtures/sso.ts";

test.use({ incognitoAccess: true });

/** The tokens the server-rendered pages of `run` read first, in order; no other page reports. */
const reportedTokens = async (run: string) =>
  (await appLog(run))
    .filter(({ kind }) => kind === "report")
    .map(({ body }) => (body as { token: unknown }).token);

test("a server session that expired by the restore hands over to the provider and back, with nothing declared", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-server-${Date.now()}`;
  const { open } = await ssoSetUp(context, serviceWorker, ssoServerUrl(run));
  // A new identity has no session either: the start meets the provider's redirect at once.
  const a = await open("A");
  expect(a.state).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  expect(await ssoServerSignIn(a.page, run, "A")).toMatchObject({ signedIn: "A" });
  const b = await open("B");
  expect(b.state).toMatchObject({ first: { token: null }, ...SIGNED_OUT });
  expect(await ssoServerSignIn(b.page, run, "B")).toMatchObject({ signedIn: "B" });

  await expireServerSessions(run);
  const back = await open("A");
  // Restored before the app ran, then signed in again through A's provider session.
  expect(back.state).toMatchObject({ first: { token: "A" }, signedIn: "A", error: null });
  // Only the pages the server rendered reported: no app script ran behind the barrier.
  expect(await reportedTokens(run)).toEqual([null, null, null, null, "A"]);
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

test("a start whose app and provider sessions both expired releases on the provider's sign-in page", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-release-${Date.now()}`;
  const { identities } = await ssoSetUp(context, serviceWorker, ssoInteractiveUrl(run));
  const tab: { page?: Page } = {};
  /** Opens `label` and returns the managed tab, released on the provider's sign-in page. */
  const signInPage = async (label: string) => {
    await identities.open(label);
    tab.page = await ssoPage(context, tab.page);
    await expect(tab.page).toHaveURL((url) => url.href.startsWith(`${IDP}/sso/authorize?`));
    return tab.page;
  };
  const a = await ssoFormSignIn(await signInPage("A"), "A");
  expect(a).toMatchObject({ first: { token: null }, signedIn: "A" });
  const b = await ssoFormSignIn(await signInPage("B"), "B");
  expect(b).toMatchObject({ first: { token: null }, signedIn: "B" });

  await expireServerSessions(run);
  await expireProviderSessions(run);
  const page = await signInPage("A");
  expect(await journalOf(serviceWorker)).toMatchObject({ step: "layout", status: "done" });
  // Released on the provider's page: no app page has rendered since B's.
  expect(await reportedTokens(run)).toEqual([null, null]);

  // The app's first script reads A's token, restored on its origin before any app script ran.
  const back = await ssoFormSignIn(page, "A");
  expect(back).toMatchObject({ first: { token: "A" }, signedIn: "A", error: null });
  expect(await reportedTokens(run)).toEqual([null, null, "A"]);
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

import { appLog } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows, journalOf } from "./fixtures/identity.ts";
import {
  expireServerSessions,
  SIGNED_OUT,
  SSO_HOSTS,
  ssoServerSignIn,
  ssoServerUrl,
  ssoSetUp,
} from "./fixtures/sso.ts";

test.use({ incognitoAccess: true });

test("a server session that expired by the restore hands over to the declared provider and back", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-server-${Date.now()}`;
  const { open } = await ssoSetUp(context, serviceWorker, ssoServerUrl(run), SSO_HOSTS);
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
  const reports = (await appLog(run)).filter(({ kind }) => kind === "report");
  // Only the pages the server rendered reported: no app script ran behind the barrier.
  expect(reports.map(({ body }) => (body as { token: unknown }).token)).toEqual([
    null,
    null,
    null,
    null,
    "A",
  ]);
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

test("a server redirect to an undeclared host still stops the start", async ({
  context,
  serviceWorker,
}) => {
  const run = `sso-server-undeclared-${Date.now()}`;
  const { identities } = await ssoSetUp(context, serviceWorker, ssoServerUrl(run));
  await expect(identities.open("A")).rejects.toThrow(
    "The page did not load (net::ERR_BLOCKED_BY_CLIENT).",
  );
  expect(await journalOf(serviceWorker)).toMatchObject({ step: "navigate", status: "failed" });
  expect(await incognitoWindows(serviceWorker)).toBe(0);
});

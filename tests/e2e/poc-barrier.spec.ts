import { appLog, appState } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import { identityFor, restoredReads, startWithIdentity } from "./fixtures/identity.ts";
import { APP, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

test("a start with an identity restores it before the app's first script runs", async ({
  context,
  serviceWorker,
}) => {
  const run = `barrier-${Date.now()}`;
  const timings = await startWithIdentity(
    serviceWorker,
    `${APP}/app/redirect?run=${run}`,
    identityFor(run),
    2_000,
  );
  expect(timings.map(({ step }) => step)).toEqual([
    "store-gone",
    "window",
    "cookie-store",
    "cookies",
    "barrier",
    "navigate",
    "restore",
    "unbarrier",
    "reload",
  ]);

  const state = await appState(await pageAt(context, `${APP}/app/?run=${run}`));
  expect(state.failure).toBeUndefined();
  expect(state.first).toMatchObject(restoredReads(run));
  const first = (await appLog(run)).find(
    ({ kind, body }) => kind === "report" && (body as { phase?: string }).phase === "first",
  );
  expect(first?.body).toMatchObject({ phase: "first", ...restoredReads(run) });
});

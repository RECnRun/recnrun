import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { tabSession, writeTabSession } from "./fixtures/layout.ts";
import { lifecycleSetUp } from "./fixtures/lifecycle.ts";
import { openTabIn } from "./fixtures/tabs.ts";
import { APP, managedWindow, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const OTHER = "http://other.localhost:5192";
const AWAY = `${OTHER}/blank?tab=main`;
const SECOND = `${APP}/blank?tab=second`;

test("a tab keeps the sessionStorage of every origin it visited across a switch, and only its own", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  const main = await next();
  await writeTabSession(main, "main on app");
  await main.goto(AWAY);
  await writeTabSession(main, "main on other");
  const managed = await managedWindow(serviceWorker);
  if (managed?.status !== "active") throw new Error("No managed window is open.");
  await openTabIn(serviceWorker, managed.windowId, SECOND);
  await writeTabSession(await pageAt(context, SECOND), "second on app");

  await identities.open("B");
  const b = await next();
  expect(await tabSession(b)).toBeNull();

  await identities.open("A");
  const back = await pageAt(context, AWAY);
  expect(await tabSession(back)).toBe("main on other");
  expect(await tabSession(await pageAt(context, SECOND))).toBe("second on app");
  // The tab left the app's origin before the switch; coming back there finds its own value.
  await back.goto(BLANK);
  expect(await tabSession(back)).toBe("main on app");
});

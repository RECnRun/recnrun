import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { keep } from "./fixtures/keep.ts";
import { incognitoLayout, shapeOf, tabSession, writeTabSession } from "./fixtures/layout.ts";
import { lifecycleSetUp } from "./fixtures/lifecycle.ts";
import { openIncognitoTab, openTabIn } from "./fixtures/tabs.ts";
import { APP, managedWindow, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const OTHER = "http://other.localhost:5192";
// Each page keeps its query, which a restore must reopen as it was.
const SECOND = `${APP}/blank?tab=second`;
const THIRD = `${OTHER}/blank?tab=third`;
const KEPT = `${APP}/blank?tab=kept`;

async function managedWindowId(serviceWorker: Parameters<typeof managedWindow>[0]) {
  const managed = await managedWindow(serviceWorker);
  if (managed?.status !== "active") throw new Error("No managed window is open.");
  return managed.windowId;
}

test("Switch saves every Incognito tab and window of A, and Switch back reopens them as they were", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  const main = await next();
  await writeTabSession(main, "main");
  await openTabIn(serviceWorker, await managedWindowId(serviceWorker), SECOND);
  await writeTabSession(await pageAt(context, SECOND), "second");
  await openIncognitoTab(serviceWorker, THIRD);
  await writeTabSession(await pageAt(context, THIRD), "third");
  const saved = shapeOf(await incognitoLayout(serviceWorker));
  expect(saved.map(({ tabs }) => tabs)).toEqual([
    [
      { url: BLANK, active: true },
      { url: SECOND, active: false },
    ],
    [{ url: THIRD, active: true }],
  ]);

  await identities.open("B");
  const b = await next();
  expect(shapeOf(await incognitoLayout(serviceWorker))).toEqual([
    { focused: expect.any(Boolean), tabs: [{ url: BLANK, active: true }] },
  ]);
  expect(await tabSession(b)).toBeNull();

  const timings = await identities.open("A");
  await keep("session-layout-switch-ms", timings);
  const back = await next();
  await expect.poll(async () => shapeOf(await incognitoLayout(serviceWorker))).toEqual(saved);
  expect(await tabSession(back)).toBe("main");
  expect(await tabSession(await pageAt(context, SECOND))).toBe("second");
  expect(await tabSession(await pageAt(context, THIRD))).toBe("third");
});

test("Switch works after the managed tab closed while another Incognito tab stays", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  const main = await next();
  await openTabIn(serviceWorker, await managedWindowId(serviceWorker), KEPT);
  await writeTabSession(await pageAt(context, KEPT), "kept");
  await main.close();

  await identities.open("B");
  await next();
  await identities.open("A");
  await expect
    .poll(async () => shapeOf(await incognitoLayout(serviceWorker)))
    .toEqual([{ focused: expect.any(Boolean), tabs: [{ url: KEPT, active: true }] }]);
  expect(await tabSession(await pageAt(context, KEPT))).toBe("kept");
});

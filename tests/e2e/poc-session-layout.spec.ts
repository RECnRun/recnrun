import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { keep } from "./fixtures/keep.ts";
import {
  incognitoLayout,
  shapeOf,
  tabEvents,
  tabSession,
  watchTabEvents,
  writeTabSession,
} from "./fixtures/layout.ts";
import { lifecycleSetUp, marksOf, stepDurations } from "./fixtures/lifecycle.ts";
import { openIncognitoTab, openNewTabIn, openTabIn, tabIdOf } from "./fixtures/tabs.ts";
import { APP, managedWindow, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const OTHER = "http://other.localhost:5192";
// Each page keeps its query, which a restore must reopen as it was.
const SECOND = `${APP}/blank?tab=second`;
const THIRD = `${OTHER}/blank?tab=third`;
const KEPT = `${APP}/blank?tab=kept`;
const NEW_TAB = "chrome://newtab/";

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

test("Switch back reopens A's other tabs while its primary tab still restores, and loads a tab of the primary's origin only after", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await next();
  await openTabIn(serviceWorker, await managedWindowId(serviceWorker), SECOND);
  await writeTabSession(await pageAt(context, SECOND), "second");
  await openIncognitoTab(serviceWorker, THIRD);
  await writeTabSession(await pageAt(context, THIRD), "third");
  const saved = shapeOf(await incognitoLayout(serviceWorker));
  await identities.open("B");
  await next();

  await watchTabEvents(serviceWorker);
  const before = (await tabEvents(serviceWorker)).length;
  const marks = await marksOf(serviceWorker, () => identities.open("A"));
  await next();
  await expect.poll(async () => shapeOf(await incognitoLayout(serviceWorker))).toEqual(saved);
  expect(await tabSession(await pageAt(context, SECOND))).toBe("second");
  expect(await tabSession(await pageAt(context, THIRD))).toBe("third");

  const events = (await tabEvents(serviceWorker)).slice(before);
  const at = (step: string) => marks.find((mark) => mark.step === step)?.at ?? Number.NaN;
  const second = await tabIdOf(serviceWorker, SECOND);
  const third = await tabIdOf(serviceWorker, THIRD);
  const created = (tabId?: number) =>
    events.find((event) => event.kind === "created" && event.tabId === tabId)?.at ?? Number.NaN;
  // Its sessionStorage is written behind a barrier at the same address first; the last commit is the app's.
  const committed = events.findLast((event) => event.kind === "committed" && event.url === SECOND);
  const started = at("store-gone");
  await keep("session-layout-concurrent-ms", {
    steps: stepDurations(marks),
    secondCreated: created(second) - started,
    thirdCreated: created(third) - started,
    secondLoaded: (committed?.at ?? Number.NaN) - started,
    restoreEnded: at("unbarrier") - started,
    reloadEnded: at("layout") - started,
  });
  // The "layout" step starts once the primary's reload committed.
  expect(Math.min(created(second), created(third))).toBeLessThan(at("layout"));
  // A tab on the primary's origin loads only once the primary's storage is back.
  expect(committed?.at).toBeGreaterThanOrEqual(at("unbarrier"));
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

test("a New Tab page and a blank tab of A come back at their places", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await next();
  const windowId = await managedWindowId(serviceWorker);
  await openTabIn(serviceWorker, windowId, "about:blank");
  await openNewTabIn(serviceWorker, windowId);
  const saved = [
    {
      focused: expect.any(Boolean),
      tabs: [
        { url: BLANK, active: true },
        { url: "about:blank", active: false },
        { url: NEW_TAB, active: false },
      ],
    },
  ];
  await expect.poll(async () => shapeOf(await incognitoLayout(serviceWorker))).toEqual(saved);

  await identities.open("B");
  await next();
  await identities.open("A");
  await expect.poll(async () => shapeOf(await incognitoLayout(serviceWorker))).toEqual(saved);
});

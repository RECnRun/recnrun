import type { BrowserContext, Page, Worker } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { incognitoLayout, shapeOf, tabSession, writeTabSession } from "./fixtures/layout.ts";
import { nextPageAt } from "./fixtures/lifecycle.ts";
import { askBeforeLeaving, newIdentity, opened, switchTo } from "./fixtures/panel.ts";
import { openSite } from "./fixtures/session.ts";
import { chromeTabs, focusTab, openIncognitoTab, openTabIn } from "./fixtures/tabs.ts";
import { APP, managedWindow, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true, viewport: { width: 1280, height: 1400 } });

const OTHER = "http://other.localhost:5192";
const AWAY = `${OTHER}/blank?tab=main`;
const SECOND = `${APP}/blank?tab=second`;
const THIRD = `${OTHER}/blank?tab=third`;

/** Saves what the dashboard shows next to the test's results, for a person to look at. */
const screen = (site: Page, name: string) =>
  site.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** Focuses the dashboard's normal window, as a click there does for a person. */
async function focusDashboard(serviceWorker: Worker, site: Page) {
  const dashboard = (await chromeTabs(serviceWorker)).find(({ url }) => url === site.url());
  if (dashboard?.id === undefined) throw new Error("No normal tab is open.");
  await focusTab(serviceWorker, dashboard.id);
}

/** Opens A through the panel with two tabs in one window, a third in another, and storage in each. */
async function openA(context: BrowserContext, serviceWorker: Worker, site: Page) {
  await newIdentity(site, BLANK);
  await opened(site, "A");
  // The managed tab writes on the app, then moves to another origin and writes there too.
  const main = await pageAt(context, BLANK);
  await writeTabSession(main, "main on app");
  await main.goto(AWAY);
  await writeTabSession(main, "main on other");
  const managed = await managedWindow(serviceWorker);
  if (managed?.status !== "active") throw new Error("No managed window is open.");
  await openTabIn(serviceWorker, managed.windowId, SECOND);
  const second = await pageAt(context, SECOND);
  await writeTabSession(second, "second");
  const dialogs = await askBeforeLeaving(second);
  await openIncognitoTab(serviceWorker, THIRD);
  await writeTabSession(await pageAt(context, THIRD), "third");
  return { main, dialogs };
}

/** Each of A's tabs holds its own storage again, the main tab on both origins it visited. */
async function expectStorageBack(context: BrowserContext) {
  const back = await pageAt(context, AWAY);
  expect(await tabSession(back)).toBe("main on other");
  expect(await tabSession(await pageAt(context, SECOND))).toBe("second");
  expect(await tabSession(await pageAt(context, THIRD))).toBe("third");
  await back.goto(BLANK);
  expect(await tabSession(back)).toBe("main on app");
}

test("the panel alone saves A's tabs, windows, and each tab's storage, and brings them all back", async ({
  context,
  serviceWorker,
}) => {
  const site = await openSite(context, "/");
  const { main, dialogs } = await openA(context, serviceWorker, site);
  const saved = shapeOf(await incognitoLayout(serviceWorker));
  expect(saved.map(({ tabs }) => tabs)).toEqual([
    [
      { url: AWAY, active: true },
      { url: SECOND, active: false },
    ],
    [{ url: THIRD, active: true }],
  ]);
  await screen(site, "1-a-open");

  // THIRD's window had the focus last in A; the dashboard holds it when the user saves.
  await focusDashboard(serviceWorker, site);
  await newIdentity(site, BLANK);
  await opened(site, "B");
  const b = await nextPageAt(context, BLANK, main);
  expect(shapeOf(await incognitoLayout(serviceWorker))).toEqual([
    { focused: expect.any(Boolean), tabs: [{ url: BLANK, active: true }] },
  ]);
  expect(await tabSession(b)).toBeNull();
  expect(dialogs).toEqual([]);
  await screen(site, "2-b-open");

  await switchTo(site, "A");
  await opened(site, "A");
  // The window focused last in A has the focus again, with its active tab.
  const back = saved.map(({ tabs }, at) => ({ focused: at === 1, tabs }));
  await expect.poll(async () => shapeOf(await incognitoLayout(serviceWorker))).toEqual(back);
  await expectStorageBack(context);
  expect(dialogs).toEqual([]);
  expect(await incognitoWindows(serviceWorker)).toBe(2);
  await screen(site, "3-back-on-a");
});

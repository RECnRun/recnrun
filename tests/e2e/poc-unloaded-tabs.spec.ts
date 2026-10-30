import type { BrowserContext, Page, Worker } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoLayout, shapeOf, tabSession, writeTabSession } from "./fixtures/layout.ts";
import { lifecycleSetUp } from "./fixtures/lifecycle.ts";
import { chromeTabs, discardTab, navigateTab, openTabIn } from "./fixtures/tabs.ts";
import { APP, managedWindow, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const OTHER = "http://other.localhost:5192";
const SECOND = `${APP}/blank?tab=second`;
const KEPT = `${APP}/blank?tab=kept`;
const NEW_TAB = "chrome://newtab/";
const MAIN = { url: BLANK, active: true };

async function managedWindowId(serviceWorker: Worker) {
  const managed = await managedWindow(serviceWorker);
  if (managed?.status !== "active") throw new Error("No managed window is open.");
  return managed.windowId;
}

/** Opens a background tab of A that writes its own sessionStorage on two origins, ending on `url`. */
async function tabOnTwoOrigins(context: BrowserContext, serviceWorker: Worker, url: string) {
  const away = url.replace(APP, OTHER);
  const tabId = await openTabIn(serviceWorker, await managedWindowId(serviceWorker), away);
  const page = await pageAt(context, away);
  await writeTabSession(page, `${url} away`);
  await page.goto(url);
  await writeTabSession(page, url);
  return tabId;
}

/** The tab at `url` holds its own entries there and on the other origin it showed. */
async function expectBothOrigins(page: Page, url: string) {
  expect(await tabSession(page)).toBe(url);
  await page.goto(url.replace(APP, OTHER));
  expect(await tabSession(page)).toBe(`${url} away`);
}

/** The id of the one Incognito tab showing `url`. */
async function incognitoTabAt(serviceWorker: Worker, url: string) {
  const found = (await chromeTabs(serviceWorker)).filter((tab) => tab.incognito && tab.url === url);
  if (found.length !== 1 || found[0]?.id === undefined) throw new Error(`Not one tab at ${url}.`);
  return found[0].id;
}

/** A's tabs, its main one first, as Chrome lists them, saved by B's start and reopened by A's. */
async function switchAway(
  identities: { open: (label: string) => Promise<unknown> },
  next: () => Promise<Page>,
  serviceWorker: Worker,
  tabs: { url: string; active: boolean }[],
) {
  const saved = [{ focused: expect.any(Boolean), tabs }];
  await expect.poll(async () => shapeOf(await incognitoLayout(serviceWorker))).toEqual(saved);
  await identities.open("B");
  await next();
  await identities.open("A");
  await expect.poll(async () => shapeOf(await incognitoLayout(serviceWorker))).toEqual(saved);
}

test("a tab Chrome unloaded comes back with its page and its sessionStorage on every origin", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await next();
  await discardTab(serviceWorker, await tabOnTwoOrigins(context, serviceWorker, SECOND));
  const tabs = [MAIN, { url: SECOND, active: false }];
  await switchAway(identities, next, serviceWorker, tabs);
  await expectBothOrigins(await pageAt(context, SECOND), SECOND);
});

test("a tab left on a blank or New Tab page keeps the sessionStorage of the sites it showed", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await next();
  const blank = await tabOnTwoOrigins(context, serviceWorker, SECOND);
  await navigateTab(serviceWorker, blank, "about:blank");
  await navigateTab(serviceWorker, await tabOnTwoOrigins(context, serviceWorker, KEPT), NEW_TAB);
  const plain = [MAIN, { url: "about:blank", active: false }, { url: NEW_TAB, active: false }];
  await switchAway(identities, next, serviceWorker, plain);
  for (const [from, url] of [
    ["about:blank", SECOND],
    [NEW_TAB, KEPT],
  ] as const) {
    await navigateTab(serviceWorker, await incognitoTabAt(serviceWorker, from), url);
    await expectBothOrigins(await pageAt(context, url), url);
  }
});

test("a session whose only web page Chrome unloaded saves that tab through its own origin", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await next();
  await discardTab(serviceWorker, await tabOnTwoOrigins(context, serviceWorker, SECOND));
  // The main tab leaves the web, so no tab runs a page a capture could read.
  await navigateTab(serviceWorker, await incognitoTabAt(serviceWorker, BLANK), "about:blank");
  const tabs = [
    { url: "about:blank", active: true },
    { url: SECOND, active: false },
  ];
  await switchAway(identities, next, serviceWorker, tabs);
  await expectBothOrigins(await pageAt(context, SECOND), SECOND);
});

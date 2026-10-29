import type { Page, Worker } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { delayStep } from "./fixtures/identity.ts";
import { writeTabSession } from "./fixtures/layout.ts";
import { newIdentity, opened, switchTo } from "./fixtures/panel.ts";
import { openSite } from "./fixtures/session.ts";
import { pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const SIGN_IN = "http://signin.localhost:5192";
const SIGN_IN_TITLE = "Sign in to Fixture";
/** Long enough to look at the tab while the start waits before the step. */
const HOLD = 2_500;

interface Tab {
  id?: number;
  url?: string;
  title?: string;
  active: boolean;
  status?: string;
}

interface TitleGlobal {
  chrome: {
    tabs: {
      onUpdated: { addListener(listener: (id: number, change: { title?: string }) => void): void };
      query(info: object): Promise<Tab[]>;
    };
    scripting: {
      executeScript(injection: object): Promise<{ result?: unknown }[]>;
    };
  };
  __titles?: string[];
}

/** Records, in the service worker, every title Chrome shows on a tab from now on. */
const watchTitles = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as TitleGlobal;
    scope.__titles = [];
    scope.chrome.tabs.onUpdated.addListener((_id, { title }) => {
      if (title !== undefined) scope.__titles?.push(title);
    });
  });

const titlesSeen = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() => (globalThis as unknown as TitleGlobal).__titles ?? []);

/** The active tab once it finished loading `url`: the managed tab, never a background helper. */
const activeTabAt = (serviceWorker: Worker, url: string) =>
  serviceWorker.evaluate(async (address) => {
    const tabs = await (globalThis as unknown as TitleGlobal).chrome.tabs.query({});
    return tabs.find((tab) => tab.active && tab.url === address && tab.status === "complete");
  }, url);

/** What the managed tab at `url` paints, read in its document, and the title Chrome shows for it. */
async function shown(serviceWorker: Worker, url: string) {
  await expect.poll(async () => (await activeTabAt(serviceWorker, url)) !== undefined).toBe(true);
  const tab = await activeTabAt(serviceWorker, url);
  const display = await serviceWorker.evaluate(async (tabId) => {
    const [frame] = await (globalThis as unknown as TitleGlobal).chrome.scripting.executeScript({
      target: { tabId },
      func: () => getComputedStyle(document.documentElement).display,
    });
    return frame?.result;
  }, tab?.id ?? -1);
  return { display, title: tab?.title };
}

const screen = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

test("a Switch paints nothing of a page behind the barrier and never shows its title", async ({
  context,
  serviceWorker,
}) => {
  const site = await openSite(context, "/");
  await newIdentity(site, BLANK);
  await opened(site, "A");
  // A's tab keeps sessionStorage on the sign-in origin, which a start writes on that origin's root.
  const main = await pageAt(context, BLANK);
  await main.goto(`${SIGN_IN}/blank?tab=main`);
  await writeTabSession(main, "main on sign-in");
  await main.goto(BLANK);
  await watchTitles(serviceWorker);
  await newIdentity(site, BLANK);
  await opened(site, "B");

  await delayStep(serviceWorker, "barrier", HOLD);
  await delayStep(serviceWorker, "restore", HOLD);
  const switched = switchTo(site, "A");
  // Held before `barrier`: the tab still shows the sign-in root its sessionStorage was written on.
  expect(await shown(serviceWorker, `${SIGN_IN}/`)).toEqual({
    display: "none",
    title: "signin.localhost:5192",
  });
  await screen(await pageAt(context, `${SIGN_IN}/`), "sign-in-root-behind-barrier");
  // Held before `restore`: the app's own document is behind the barrier.
  expect(await shown(serviceWorker, BLANK)).toEqual({
    display: "none",
    title: "app.localhost:5192/blank",
  });
  await screen(await pageAt(context, BLANK), "target-behind-barrier");
  await switched;
  await delayStep(serviceWorker, "barrier", 0);
  await delayStep(serviceWorker, "restore", 0);
  await opened(site, "A");

  expect(await shown(serviceWorker, BLANK)).toEqual({ display: "block", title: "Blank" });
  await screen(await pageAt(context, BLANK), "released");
  expect(await titlesSeen(serviceWorker)).not.toContain(SIGN_IN_TITLE);
});

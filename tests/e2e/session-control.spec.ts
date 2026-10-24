import type { BrowserContext, FrameLocator, Locator, Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { chromeTabs, recordedTabId, sessionUrl, storedSession, tabIdOf } from "./fixtures/tabs.ts";

const FRAME = 'iframe[title="RECnRun dashboard"]';
const SESSION_FRAME = 'iframe[title="RECnRun session"]';
const FLOATING = "The session floats in its own window.";

const dashboardOf = (site: Page) => site.locator(FRAME).contentFrame();

/** The recording panel of the session page that a PiP window frames. */
const panelIn = (pip: Page) =>
  pip.locator(SESSION_FRAME).contentFrame().getByRole("region", { name: "Recording panel" });

const tabItem = (dashboard: FrameLocator, url: string) =>
  dashboard
    .getByRole("complementary", { name: "Tabs" })
    .getByRole("listitem")
    .filter({ hasText: url });

/** A site tab, at its own path so each dashboard's own row has a distinct address. */
async function openSite(context: BrowserContext, path: string): Promise<Page> {
  const site = await context.newPage();
  await site.goto(path);
  await expect(dashboardOf(site).getByRole("heading", { name: "Tabs" })).toBeVisible();
  return site;
}

/** The PiP window is a page of its own in Playwright; this waits for the one a click opens. */
async function clickToOpenPanel(context: BrowserContext, button: Locator): Promise<Page> {
  const [pip] = await Promise.all([context.waitForEvent("page"), button.click()]);
  return pip;
}

/** Playwright emulates focus, so Chrome's active tab is read from the service worker. */
const activeTabId = async (serviceWorker: Worker) =>
  (await chromeTabs(serviceWorker)).find((tab) => tab.active)?.id;

// The privacy policy has no dashboard frame, so it stands in for the user's own application.
const APP = "/privacy/";

interface Setup {
  app: Page;
  site: Page;
  pip: Page;
}

/** Records the app tab from the site's dashboard, as a user would. */
async function recordFrom(context: BrowserContext, app: Page, sitePath = "/"): Promise<Setup> {
  const site = await openSite(context, sitePath);
  const record = tabItem(dashboardOf(site), app.url()).getByRole("button", { name: "Record" });
  const pip = await clickToOpenPanel(context, record);
  await expect(panelIn(pip)).toContainText("Recording");
  return { app, site, pip };
}

test.beforeEach(async ({ page, seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
  await page.goto(APP);
});

test("Record opens the session in a PiP window and shows the tab it records", async ({
  context,
  page,
  serviceWorker,
}) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { pip, site } = await recordFrom(context, page);

  await expect(pip.locator(SESSION_FRAME)).toHaveAttribute("src", sessionUrl(serviceWorker));
  const logo = panelIn(pip).getByRole("img", { name: "RECnRun" });
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const appId = await tabIdOf(serviceWorker, page.url());
  expect(await recordedTabId(serviceWorker)).toBe(appId);
  await expect.poll(() => activeTabId(serviceWorker)).toBe(appId);

  for (const dashboard of [dashboardOf(site), dashboardOf(other)]) {
    const recorded = tabItem(dashboard, page.url());
    await expect(recorded).toContainText(/Recording \d\d:\d\d/);
    await expect(recorded).toContainText(FLOATING);
    await expect(recorded.getByRole("button")).toHaveCount(0);
    await expect(tabItem(dashboard, other.url()).getByRole("button")).toHaveCount(0);
  }

  await panelIn(pip).getByRole("button", { name: "Pause" }).click();
  await expect(tabItem(dashboardOf(other), page.url())).toContainText("Paused");
  await panelIn(pip).getByRole("button", { name: "Resume" }).click();
  await expect(tabItem(dashboardOf(other), page.url())).toContainText("Recording");
});

test("Stop ends the session, closes its window, and returns to the dashboard", async ({
  context,
  page,
  serviceWorker,
}) => {
  const { pip, site } = await recordFrom(context, page);
  await panelIn(pip).getByRole("button", { name: "Stop" }).click();

  await expect.poll(() => pip.isClosed()).toBe(true);
  expect(await recordedTabId(serviceWorker)).toBeNull();
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, site.url()));
  await expect(tabItem(dashboardOf(site), page.url()).getByRole("button")).toHaveText(["Record"]);
});

test("closing the PiP window keeps the session and gives the control back", async ({
  context,
  page,
  serviceWorker,
}) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { pip, site } = await recordFrom(context, page);
  const started = await storedSession(serviceWorker);

  await pip.close();
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, site.url()));
  for (const dashboard of [dashboardOf(site), dashboardOf(other)]) {
    const recorded = tabItem(dashboard, page.url());
    await expect(recorded.getByRole("button")).toHaveText(["Continue", "Stop"]);
    await expect(recorded).toContainText(/Recording \d\d:\d\d/);
  }
  expect(await storedSession(serviceWorker)).toEqual(started);

  const reopened = await clickToOpenPanel(
    context,
    tabItem(dashboardOf(other), page.url()).getByRole("button", { name: "Continue" }),
  );
  await expect(panelIn(reopened)).toContainText("Recording");
  expect(await storedSession(serviceWorker)).toEqual(started);
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, page.url()));
  await expect(tabItem(dashboardOf(site), page.url())).toContainText(FLOATING);
});

test("closing the controlling site tab leaves the session for another dashboard", async ({
  context,
  page,
  serviceWorker,
}) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { pip, site } = await recordFrom(context, page);
  const started = await storedSession(serviceWorker);

  await site.close();
  await expect.poll(() => pip.isClosed()).toBe(true);
  const recorded = tabItem(dashboardOf(other), page.url());
  await expect(recorded.getByRole("button")).toHaveText(["Continue", "Stop"]);
  expect(await storedSession(serviceWorker)).toEqual(started);

  const reopened = await clickToOpenPanel(
    context,
    recorded.getByRole("button", { name: "Continue" }),
  );
  await expect(panelIn(reopened)).toContainText("Recording");
  expect(await storedSession(serviceWorker)).toEqual(started);
});

test("another dashboard ends a session left without control, without a PiP window", async ({
  context,
  page,
  serviceWorker,
}) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { site, pip } = await recordFrom(context, page);
  await site.close();
  // The PiP window goes with the tab that opened it.
  await expect.poll(() => pip.isClosed()).toBe(true);

  const pages = context.pages().length;
  await tabItem(dashboardOf(other), page.url()).getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => recordedTabId(serviceWorker)).toBeNull();
  await expect(tabItem(dashboardOf(other), page.url()).getByRole("button")).toHaveText(["Record"]);
  expect(context.pages()).toHaveLength(pages);
});

test("two dashboards starting at once give the control to only one of them", async ({
  context,
  page,
  serviceWorker,
}) => {
  const first = await openSite(context, "/");
  const second = await openSite(context, "/recordings/rec-login");
  const buttons = [first, second].map((site) =>
    tabItem(dashboardOf(site), page.url()).getByRole("button", { name: "Record" }),
  );
  await Promise.all(buttons.map((button) => expect(button).toBeVisible()));

  const opened: Page[] = [];
  context.on("page", (each) => opened.push(each));
  // Both clicks land before either dashboard sees the other's session.
  await Promise.all(buttons.map((button) => button.evaluate((each: HTMLElement) => each.click())));
  await expect.poll(() => opened.length).toBe(1);
  await expect(panelIn(opened[0] as Page)).toContainText("Recording");
  // A second window would have closed the first, since Chrome keeps one PiP window at a time.
  await expect.poll(() => opened.filter((each) => !each.isClosed()).length).toBe(1);
  expect(await recordedTabId(serviceWorker)).toBe(await tabIdOf(serviceWorker, page.url()));
});

test("reloading the dashboards keeps the session", async ({ context, page, serviceWorker }) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { pip, site } = await recordFrom(context, page);
  const started = await storedSession(serviceWorker);

  await other.reload();
  await expect(tabItem(dashboardOf(other), page.url())).toContainText(FLOATING);
  await site.reload();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect(tabItem(dashboardOf(site), page.url()).getByRole("button")).toHaveText([
    "Continue",
    "Stop",
  ]);
  expect(await storedSession(serviceWorker)).toEqual(started);
});

test("closing the recorded tab ends the session and closes its window", async ({
  context,
  page,
  serviceWorker,
}) => {
  const { pip, site } = await recordFrom(context, page);
  await page.close();
  await expect.poll(() => recordedTabId(serviceWorker)).toBeNull();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, site.url()));
});

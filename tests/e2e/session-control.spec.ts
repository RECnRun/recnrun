import type { BrowserContext, Page } from "@playwright/test";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test as base } from "./fixtures/extension.ts";
import {
  activeTabId,
  clickInDashboard,
  clickToOpenPanel,
  dashboardOf,
  FLOATING,
  openSite,
  panelIn,
  SESSION_FRAME,
  tabItem,
} from "./fixtures/session.ts";
import { recordedTabId, sessionUrl, storedSession, tabIdOf, watchFocus } from "./fixtures/tabs.ts";
import { APP, openWorkspaceApp } from "./fixtures/workspace.ts";
import type { WorkspaceApp } from "./fixtures/workspace.ts";

/**
 * The managed Incognito tab, the only one RECnRun records, started from the `page` fixture's
 * dashboard at the root; the tests' own dashboards open elsewhere so each address names one tab.
 */
const test = base.extend<{ app: WorkspaceApp }>({
  app: async ({ page, serviceWorker, seedSnapshot }, use) => {
    await seedSnapshot(sampleSnapshot());
    await watchFocus(serviceWorker);
    await page.goto("/");
    await expect(dashboardOf(page).getByRole("heading", { name: "Tabs" })).toBeVisible();
    await use(await openWorkspaceApp(page, serviceWorker, `${APP}/inspect?run=session`));
  },
});

test.use({ incognitoAccess: true });

interface Setup {
  site: Page;
  pip: Page;
}

/** Records the managed tab from the site's dashboard, as a user would. */
async function recordFrom(
  context: BrowserContext,
  app: WorkspaceApp,
  sitePath = "/recordings",
): Promise<Setup> {
  const site = await openSite(context, sitePath);
  const record = tabItem(dashboardOf(site), app.url).getByRole("button", { name: "Record" });
  const pip = await clickToOpenPanel(context, record);
  await expect(panelIn(pip)).toContainText("Recording");
  return { site, pip };
}

test("Record opens the session in a PiP window and shows the tab it records", async ({
  context,
  app,
  serviceWorker,
}) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { pip, site } = await recordFrom(context, app);

  await expect(pip.locator(SESSION_FRAME)).toHaveAttribute("src", sessionUrl(serviceWorker));
  const logo = panelIn(pip).getByRole("img", { name: "RECnRun" });
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const appId = app.id;
  expect(await recordedTabId(serviceWorker)).toBe(appId);
  await expect.poll(() => activeTabId(serviceWorker)).toBe(appId);

  for (const dashboard of [dashboardOf(site), dashboardOf(other)]) {
    const recorded = tabItem(dashboard, app.url);
    await expect(recorded).toContainText(/Recording \d\d:\d\d/);
    await expect(recorded).toContainText(FLOATING);
    await expect(recorded.getByRole("button")).toHaveCount(0);
    await expect(
      tabItem(dashboard, other.url()).getByRole("button", { name: "Record" }),
    ).toHaveCount(0);
  }

  await panelIn(pip).getByRole("button", { name: "Pause" }).click();
  await expect(tabItem(dashboardOf(other), app.url)).toContainText("Paused");
  await panelIn(pip).getByRole("button", { name: "Resume" }).click();
  await expect(tabItem(dashboardOf(other), app.url)).toContainText("Recording");
});

test("Stop ends the session, closes its window, and returns to the dashboard", async ({
  context,
  app,
  serviceWorker,
}) => {
  const { pip, site } = await recordFrom(context, app);
  await panelIn(pip).getByRole("button", { name: "Stop" }).click();

  await expect.poll(() => pip.isClosed()).toBe(true);
  expect(await recordedTabId(serviceWorker)).toBeNull();
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, site.url()));
  await expect(tabItem(dashboardOf(site), app.url).getByRole("button")).toHaveText(["Record"]);
});

test("closing the PiP window keeps the session and gives the control back", async ({
  context,
  app,
  serviceWorker,
}) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { pip, site } = await recordFrom(context, app);
  const started = await storedSession(serviceWorker);

  await pip.close();
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, site.url()));
  for (const dashboard of [dashboardOf(site), dashboardOf(other)]) {
    const recorded = tabItem(dashboard, app.url);
    await expect(recorded.getByRole("button")).toHaveText(["Continue", "Stop"]);
    await expect(recorded).toContainText(/Recording \d\d:\d\d/);
  }
  expect(await storedSession(serviceWorker)).toEqual(started);

  const reopened = await clickToOpenPanel(
    context,
    tabItem(dashboardOf(other), app.url).getByRole("button", { name: "Continue" }),
  );
  await expect(panelIn(reopened)).toContainText("Recording");
  expect(await storedSession(serviceWorker)).toEqual(started);
  await expect.poll(() => activeTabId(serviceWorker)).toBe(app.id);
  await expect(tabItem(dashboardOf(site), app.url)).toContainText(FLOATING);
});

test("closing the controlling site tab leaves the session for another dashboard", async ({
  context,
  app,
  serviceWorker,
}) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { pip, site } = await recordFrom(context, app);
  const started = await storedSession(serviceWorker);

  await site.close();
  await expect.poll(() => pip.isClosed()).toBe(true);
  const recorded = tabItem(dashboardOf(other), app.url);
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
  app,
  serviceWorker,
}) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { site, pip } = await recordFrom(context, app);
  await site.close();
  // The PiP window goes with the tab that opened it.
  await expect.poll(() => pip.isClosed()).toBe(true);

  const pages = context.pages().length;
  await clickInDashboard(
    tabItem(dashboardOf(other), app.url).getByRole("button", { name: "Stop" }),
  );
  await expect.poll(() => recordedTabId(serviceWorker)).toBeNull();
  await expect(tabItem(dashboardOf(other), app.url).getByRole("button")).toHaveText(["Record"]);
  expect(context.pages()).toHaveLength(pages);
});

test("two dashboards starting at once give the control to only one of them", async ({
  context,
  app,
  serviceWorker,
}) => {
  const first = await openSite(context, "/");
  const second = await openSite(context, "/recordings/rec-login");
  const buttons = [first, second].map((site) =>
    tabItem(dashboardOf(site), app.url).getByRole("button", { name: "Record" }),
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
  expect(await recordedTabId(serviceWorker)).toBe(app.id);
});

test("reloading the dashboards keeps the session", async ({ context, app, serviceWorker }) => {
  const other = await openSite(context, "/recordings/rec-login");
  const { pip, site } = await recordFrom(context, app);
  const started = await storedSession(serviceWorker);

  await other.reload();
  await expect(tabItem(dashboardOf(other), app.url)).toContainText(FLOATING);
  await site.reload();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect(tabItem(dashboardOf(site), app.url).getByRole("button")).toHaveText([
    "Continue",
    "Stop",
  ]);
  expect(await storedSession(serviceWorker)).toEqual(started);
});

test("closing the recorded tab keeps the session until the PiP window stops it", async ({
  context,
  app,
  serviceWorker,
}) => {
  const { pip, site } = await recordFrom(context, app);
  const started = await storedSession(serviceWorker);
  await app.page.close();

  const closed = dashboardOf(site).getByRole("listitem", { name: "Closed tab" });
  await expect(closed).toContainText(FLOATING);
  expect(pip.isClosed()).toBe(false);
  await expect(panelIn(pip)).toContainText("Recording");
  expect(await storedSession(serviceWorker)).toEqual(started);

  await panelIn(pip).getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => recordedTabId(serviceWorker)).toBeNull();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect(closed).toHaveCount(0);
});

test("a session whose tab closed, left without control, is stopped from a dashboard", async ({
  context,
  app,
  serviceWorker,
}) => {
  const { pip, site } = await recordFrom(context, app);
  await app.page.close();
  await pip.close();

  const closed = dashboardOf(site).getByRole("listitem", { name: "Closed tab" });
  await expect(closed.getByRole("button")).toHaveText(["Stop"]);
  expect(await recordedTabId(serviceWorker)).not.toBeNull();
  await clickInDashboard(closed.getByRole("button", { name: "Stop" }));
  await expect.poll(() => recordedTabId(serviceWorker)).toBeNull();
  await expect(closed).toHaveCount(0);
});

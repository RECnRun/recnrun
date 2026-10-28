import type { BrowserContext, Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "./fixtures/extension.ts";
import {
  activeTabId,
  clickToOpenPanel,
  FLOATING,
  openDashboard,
  panelIn,
  tabItem,
} from "./fixtures/session.ts";
import { recordedTabId, storedSession, tabIdOf } from "./fixtures/tabs.ts";

// The privacy policy runs no RECnRun script, so it stands in for the user's own application.
const APP = "/privacy/";
const LOGIN = "#/recordings/rec-login";

interface Setup {
  dashboard: Page;
  pip: Page;
}

/** Records the app tab from a dashboard tab, as a user would. */
async function recordFrom(
  context: BrowserContext,
  serviceWorker: Worker,
  app: Page,
): Promise<Setup> {
  const dashboard = await openDashboard(context, serviceWorker);
  const record = tabItem(dashboard, app.url()).getByRole("button", { name: "Record" });
  const pip = await clickToOpenPanel(context, record);
  await expect(panelIn(pip)).toContainText("Recording");
  return { dashboard, pip };
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
  const other = await openDashboard(context, serviceWorker, LOGIN);
  const { pip, dashboard } = await recordFrom(context, serviceWorker, page);

  const logo = panelIn(pip).getByRole("img", { name: "RECnRun" });
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const appId = await tabIdOf(serviceWorker, page.url());
  expect(await recordedTabId(serviceWorker)).toBe(appId);
  await expect.poll(() => activeTabId(serviceWorker)).toBe(appId);

  for (const each of [dashboard, other]) {
    const recorded = tabItem(each, page.url());
    await expect(recorded).toContainText(/Recording \d\d:\d\d/);
    await expect(recorded).toContainText(FLOATING);
    await expect(recorded.getByRole("button")).toHaveCount(0);
    await expect(tabItem(each, other.url()).getByRole("button")).toHaveCount(0);
  }

  await panelIn(pip).getByRole("button", { name: "Pause" }).click();
  await expect(tabItem(other, page.url())).toContainText("Paused");
  await panelIn(pip).getByRole("button", { name: "Resume" }).click();
  await expect(tabItem(other, page.url())).toContainText("Recording");
});

test("Stop ends the session, closes its window, and returns to the dashboard", async ({
  context,
  page,
  serviceWorker,
}) => {
  const { pip, dashboard } = await recordFrom(context, serviceWorker, page);
  await panelIn(pip).getByRole("button", { name: "Stop" }).click();

  await expect.poll(() => pip.isClosed()).toBe(true);
  expect(await recordedTabId(serviceWorker)).toBeNull();
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, dashboard.url()));
  await expect(tabItem(dashboard, page.url()).getByRole("button")).toHaveText(["Record"]);
});

test("closing the PiP window keeps the session and gives the control back", async ({
  context,
  page,
  serviceWorker,
}) => {
  const other = await openDashboard(context, serviceWorker, LOGIN);
  const { pip, dashboard } = await recordFrom(context, serviceWorker, page);
  const started = await storedSession(serviceWorker);

  await pip.close();
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, dashboard.url()));
  for (const each of [dashboard, other]) {
    const recorded = tabItem(each, page.url());
    await expect(recorded.getByRole("button")).toHaveText(["Continue", "Stop"]);
    await expect(recorded).toContainText(/Recording \d\d:\d\d/);
  }
  expect(await storedSession(serviceWorker)).toEqual(started);

  const reopened = await clickToOpenPanel(
    context,
    tabItem(other, page.url()).getByRole("button", { name: "Continue" }),
  );
  await expect(panelIn(reopened)).toContainText("Recording");
  expect(await storedSession(serviceWorker)).toEqual(started);
  await expect
    .poll(() => activeTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, page.url()));
  await expect(tabItem(dashboard, page.url())).toContainText(FLOATING);
});

test("closing the controlling dashboard tab leaves the session for another one", async ({
  context,
  page,
  serviceWorker,
}) => {
  const other = await openDashboard(context, serviceWorker, LOGIN);
  const { pip, dashboard } = await recordFrom(context, serviceWorker, page);
  const started = await storedSession(serviceWorker);

  await dashboard.close();
  await expect.poll(() => pip.isClosed()).toBe(true);
  const recorded = tabItem(other, page.url());
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
  const other = await openDashboard(context, serviceWorker, LOGIN);
  const { dashboard, pip } = await recordFrom(context, serviceWorker, page);
  await dashboard.close();
  // The PiP window goes with the tab that opened it.
  await expect.poll(() => pip.isClosed()).toBe(true);

  const pages = context.pages().length;
  await tabItem(other, page.url()).getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => recordedTabId(serviceWorker)).toBeNull();
  await expect(tabItem(other, page.url()).getByRole("button")).toHaveText(["Record"]);
  expect(context.pages()).toHaveLength(pages);
});

test("two dashboards starting at once give the control to only one of them", async ({
  context,
  page,
  serviceWorker,
}) => {
  const first = await openDashboard(context, serviceWorker);
  const second = await openDashboard(context, serviceWorker, LOGIN);
  const buttons = [first, second].map((each) =>
    tabItem(each, page.url()).getByRole("button", { name: "Record" }),
  );
  await Promise.all(buttons.map((button) => expect(button).toBeVisible()));

  const opened: Page[] = [];
  context.on("page", (each) => opened.push(each));
  // Both clicks land at one moment, before either dashboard hears of the other's control; Playwright
  // evaluates with a user gesture, which PiP needs.
  const handles = await Promise.all(buttons.map((button) => button.elementHandle()));
  const at = Date.now() + 300;
  await Promise.all(
    handles.map((handle) =>
      handle.evaluate((each, moment) => {
        setTimeout(() => (each as HTMLElement).click(), moment - Date.now());
      }, at),
    ),
  );
  await expect
    .poll(() => recordedTabId(serviceWorker))
    .toBe(await tabIdOf(serviceWorker, page.url()));
  for (const each of [first, second]) {
    await expect(tabItem(each, page.url())).toContainText(FLOATING);
  }
  expect(opened).toHaveLength(1);
  await expect(panelIn(opened[0] as Page)).toContainText("Recording");
});

test("reloading the dashboards keeps the session", async ({ context, page, serviceWorker }) => {
  const other = await openDashboard(context, serviceWorker, LOGIN);
  const { pip, dashboard } = await recordFrom(context, serviceWorker, page);
  const started = await storedSession(serviceWorker);

  await other.reload();
  await expect(tabItem(other, page.url())).toContainText(FLOATING);
  await dashboard.reload();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect(tabItem(dashboard, page.url()).getByRole("button")).toHaveText(["Continue", "Stop"]);
  expect(await storedSession(serviceWorker)).toEqual(started);
});

test("closing the recorded tab keeps the session until the PiP window stops it", async ({
  context,
  page,
  serviceWorker,
}) => {
  const { pip, dashboard } = await recordFrom(context, serviceWorker, page);
  const started = await storedSession(serviceWorker);
  await page.close();

  const closed = dashboard.getByRole("listitem", { name: "Closed tab" });
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
  page,
  serviceWorker,
}) => {
  const { pip, dashboard } = await recordFrom(context, serviceWorker, page);
  await page.close();
  await pip.close();

  const closed = dashboard.getByRole("listitem", { name: "Closed tab" });
  await expect(closed.getByRole("button")).toHaveText(["Stop"]);
  expect(await recordedTabId(serviceWorker)).not.toBeNull();
  await closed.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => recordedTabId(serviceWorker)).toBeNull();
  await expect(closed).toHaveCount(0);
});

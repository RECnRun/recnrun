import type { Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { dashboardPages, dashboardSplit, dashboardUrl } from "./fixtures/tabs.ts";

test.use({ remoteDebuggingPort: 9334 });

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

/** Marks the page's window, which a reload would clear. */
const mark = (page: Page) =>
  page.evaluate(() => {
    Object.assign(window, { recnrunMark: true });
  });
const marked = (page: Page) => page.evaluate(() => "recnrunMark" in window);

interface TriggerGlobal {
  chrome: { tabs: { query(filter: object): Promise<{ active: boolean; url?: string }[]> } };
  recnrunOpenDashboard(tab?: object): Promise<void>;
}

/** Runs the toolbar icon's action for the active page and waits until it is done. */
function triggerOnActivePage(serviceWorker: Worker) {
  return serviceWorker.evaluate(async (dashboard) => {
    const scope = globalThis as unknown as TriggerGlobal;
    const tabs = await scope.chrome.tabs.query({});
    const page = tabs.find((tab) => tab.active && !tab.url?.startsWith(dashboard));
    await scope.recnrunOpenDashboard(page);
  }, dashboardUrl(serviceWorker));
}

test("moves the open dashboard beside the next page without reloading it", async ({
  context,
  page,
  serviceWorker,
  clickToolbarIcon,
}) => {
  await page.goto("/");
  await clickToolbarIcon(page);
  await expect.poll(() => dashboardPages(context, serviceWorker).length).toBe(1);
  const [dashboard] = dashboardPages(context, serviceWorker);
  if (!dashboard) throw new Error("No dashboard page opened.");
  await expect(dashboard.getByRole("region")).toHaveCount(1);
  await mark(dashboard);
  const site = (await dashboardSplit(serviceWorker)).partner?.id;
  expect(site).toBeDefined();

  const blank = await context.newPage();
  await clickToolbarIcon(blank);
  await expect.poll(async () => (await dashboardSplit(serviceWorker)).partner?.id).not.toBe(site);
  const { dashboard: moved, partner } = await dashboardSplit(serviceWorker);
  expect(partner).toBeDefined();
  expect(moved?.index).toBe((partner?.index ?? -2) + 1);
  expect(moved?.active).toBe(true);
  expect(await marked(dashboard)).toBe(true);
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
  // A blank tab shows every workspace, which a reload keeps.
  await expect(dashboard.getByRole("region")).toHaveCount(2);
  await expect.poll(() => dashboard.url()).toBe(dashboardUrl(serviceWorker));
});

test("a second dashboard tab hands its route to the first one and closes", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto(dashboardUrl(serviceWorker));
  await expect(page.getByRole("region")).toHaveCount(2);
  await mark(page);

  const second = await context.newPage();
  // The page closes itself, which can interrupt this navigation.
  second.goto(`${dashboardUrl(serviceWorker)}#/recordings/rec-checkout`).catch(() => {});
  await expect.poll(() => second.isClosed()).toBe(true);
  await expect(page).toHaveURL(`${dashboardUrl(serviceWorker)}#/recordings/rec-checkout`);
  await expect(page.getByRole("article")).toHaveAccessibleName("Checkout with saved card");
  expect(await marked(page)).toBe(true);
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
});

test("an older tab that loads the dashboard hands its route to the open one, which takes the focus and keeps its panel", async ({
  context,
  page,
  serviceWorker,
}) => {
  // The fixture's page is older than the dashboard tab, so Chrome gave it a lower tab id.
  // Closing the active page alone would activate its neighbor, not the dashboard.
  const neighbor = await context.newPage();
  await neighbor.goto("/");
  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl(serviceWorker));
  await mark(dashboard);
  const [pip] = await Promise.all([
    context.waitForEvent("page"),
    dashboard.getByRole("button", { name: "Record" }).click(),
  ]);

  await page.bringToFront();
  await expect
    .poll(async () => (await dashboardSplit(serviceWorker)).dashboard?.active)
    .toBe(false);
  page.goto(`${dashboardUrl(serviceWorker)}#/recordings/rec-checkout`).catch(() => {});
  await expect.poll(() => page.isClosed()).toBe(true);
  await expect.poll(async () => (await dashboardSplit(serviceWorker)).dashboard?.active).toBe(true);
  await expect(dashboard.getByRole("article")).toHaveAccessibleName("Checkout with saved card");
  expect(await marked(dashboard)).toBe(true);
  expect(pip.isClosed()).toBe(false);
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
});

test("dashboard tabs that load at once leave one open", async ({
  context,
  page,
  serviceWorker,
}) => {
  const pages = [page, await context.newPage(), await context.newPage()];
  for (const each of pages) each.goto(dashboardUrl(serviceWorker)).catch(() => {});

  await expect.poll(() => pages.filter((each) => !each.isClosed()).length).toBe(1);
  const [open] = dashboardPages(context, serviceWorker);
  if (!open) throw new Error("No dashboard tab stayed open.");
  await expect(open.getByRole("region")).toHaveCount(2);
});

test("triggers leave the dashboard alone while its PiP panel floats", async ({
  context,
  page,
  serviceWorker,
  clickToolbarIcon,
}) => {
  await page.goto("/");
  await clickToolbarIcon(page);
  await expect.poll(() => dashboardPages(context, serviceWorker).length).toBe(1);
  const [dashboard] = dashboardPages(context, serviceWorker);
  if (!dashboard) throw new Error("No dashboard page opened.");
  const [pip] = await Promise.all([
    context.waitForEvent("page"),
    dashboard.getByRole("button", { name: "Record" }).click(),
  ]);
  await expect
    .poll(async () => (await dashboardSplit(serviceWorker)).dashboard)
    .toMatchObject({ active: false, splitViewId: -1 });

  await triggerOnActivePage(serviceWorker);
  await context.newPage();
  await triggerOnActivePage(serviceWorker);
  expect((await dashboardSplit(serviceWorker)).dashboard).toMatchObject({
    active: false,
    splitViewId: -1,
  });
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
  expect(pip.isClosed()).toBe(false);
});

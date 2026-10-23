import type { BrowserContext, Worker } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

interface ChromeGlobal {
  chrome: {
    tabs: {
      query(filter: object): Promise<{ url?: string; active: boolean; splitViewId?: number }[]>;
    };
  };
}

test.use({ remoteDebuggingPort: 9333 });

const dashboardUrl = (serviceWorker: Worker) => new URL("dashboard.html", serviceWorker.url()).href;

const dashboardPages = (context: BrowserContext, serviceWorker: Worker) =>
  context.pages().filter((page) => page.url().startsWith(dashboardUrl(serviceWorker)));

/** Every tab's Split View id, and whether it shows the dashboard. */
function splitTabs(serviceWorker: Worker) {
  return serviceWorker.evaluate(async (dashboard) => {
    const tabs = await (globalThis as unknown as ChromeGlobal).chrome.tabs.query({});
    return tabs.map((tab) => ({
      dashboard: tab.url?.startsWith(dashboard) ?? false,
      active: tab.active,
      splitViewId: tab.splitViewId,
    }));
  }, dashboardUrl(serviceWorker));
}

test.beforeEach(async ({ seedSnapshot }) => {
  const snapshot = sampleSnapshot();
  snapshot.recordings.push({
    id: "rec-site",
    name: "Install the extension",
    startUrl: "http://localhost:5190/",
    createdAt: "2026-10-03T10:00:00.000Z",
    durationMs: 8_000,
    eventCount: 4,
  });
  await seedSnapshot(snapshot);
});

test("opens the page's workspace next to it in a Split View", async ({
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
  expect(dashboard.url()).toBe(
    `${dashboardUrl(serviceWorker)}?workspace=http%3A%2F%2Flocalhost%3A5190`,
  );
  const tabs = await splitTabs(serviceWorker);
  const split = tabs.find((tab) => tab.dashboard)?.splitViewId;
  expect(split).not.toBe(-1);
  expect(tabs.filter((tab) => tab.splitViewId === split)).toHaveLength(2);

  await expect(dashboard.getByRole("region", { name: "localhost:5190" })).toBeVisible();
  await expect(dashboard.getByRole("article")).toHaveAccessibleName("Install the extension");
  await expect(dashboard).toHaveTitle("localhost:5190 · RECnRun");
});

test("focuses the split dashboard instead of opening another", async ({
  context,
  page,
  serviceWorker,
  clickToolbarIcon,
}) => {
  await page.goto("/");
  await clickToolbarIcon(page);
  await expect.poll(() => dashboardPages(context, serviceWorker).length).toBe(1);
  const split = (await splitTabs(serviceWorker)).find((tab) => tab.dashboard)?.splitViewId;
  expect(split).not.toBe(-1);
  await page.bringToFront();
  await expect
    .poll(async () => (await splitTabs(serviceWorker)).find((tab) => tab.dashboard)?.active)
    .toBe(false);

  await clickToolbarIcon(page);
  await expect
    .poll(async () => (await splitTabs(serviceWorker)).find((tab) => tab.dashboard)?.active)
    .toBe(true);
  expect(dashboardPages(context, serviceWorker)).toHaveLength(1);
});

test("turns a blank tab into the dashboard of every workspace", async ({
  context,
  page,
  serviceWorker,
  clickToolbarIcon,
}) => {
  // The persistent context starts with its own blank tab; only the test's page may show about:blank.
  await Promise.all(
    context
      .pages()
      .filter((each) => each !== page)
      .map((each) => each.close()),
  );
  await clickToolbarIcon(page);

  await expect(page).toHaveURL(dashboardUrl(serviceWorker));
  await expect(page.getByRole("region")).toHaveCount(3);
  await expect(page.getByRole("article")).toHaveCount(3);
  expect(context.pages()).toHaveLength(1);
});

test("recording from the split dashboard leaves the page alone until Stop splits it again", async ({
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
    .poll(async () => (await splitTabs(serviceWorker)).find((tab) => tab.dashboard))
    .toMatchObject({ active: false, splitViewId: -1 });
  const site = (await splitTabs(serviceWorker)).find((tab) => tab.active);
  expect(site).toMatchObject({ dashboard: false, splitViewId: -1 });
  await expect(pip.getByRole("region", { name: "Recording panel" })).toContainText("Recording");

  await pip.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect
    .poll(async () => {
      const tabs = await splitTabs(serviceWorker);
      const split = tabs.find((tab) => tab.dashboard && tab.active)?.splitViewId ?? -1;
      return split === -1 ? 0 : tabs.filter((tab) => tab.splitViewId === split).length;
    })
    .toBe(2);
});

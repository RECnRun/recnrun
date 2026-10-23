import type { Page } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  chromeTabs,
  dashboardPages,
  recordedTabId,
  sessionPages,
  sessionSplit,
  tabIdOf,
  triggerSessionOn,
} from "./fixtures/tabs.ts";

test.use({ remoteDebuggingPort: 9333 });

const panelOf = (page: Page) => page.getByRole("region", { name: "Recording panel" });

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

test("the toolbar icon records the page with the session split beside it", async ({
  context,
  page,
  serviceWorker,
  clickToolbarIcon,
}) => {
  await page.goto("/");
  await clickToolbarIcon(page);

  await expect.poll(() => sessionPages(context, serviceWorker).length).toBe(1);
  const [pane] = sessionPages(context, serviceWorker);
  if (!pane) throw new Error("No session pane opened.");
  await expect(panelOf(pane)).toContainText(/Recording 00:0\d/);
  await expect(pane).toHaveTitle("RECnRun session");
  const { partner } = await sessionSplit(serviceWorker);
  expect(partner?.id).toBe(await tabIdOf(serviceWorker, page.url()));
  expect(await recordedTabId(serviceWorker)).toBe(partner?.id);

  await page.bringToFront();
  await expect.poll(async () => (await sessionSplit(serviceWorker)).pane?.active).toBe(false);
  await clickToolbarIcon(page);
  await expect.poll(async () => (await sessionSplit(serviceWorker)).pane?.active).toBe(true);
  expect(sessionPages(context, serviceWorker)).toHaveLength(1);
});

test("a trigger on another tab moves the running session beside it without reloading", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/");
  await triggerSessionOn(serviceWorker, page);
  await expect.poll(() => sessionPages(context, serviceWorker).length).toBe(1);
  const [pane] = sessionPages(context, serviceWorker);
  if (!pane) throw new Error("No session pane opened.");
  await pane.getByRole("button", { name: "Pause" }).click();
  await expect(panelOf(pane)).toContainText("Paused");
  await pane.evaluate(() => Object.assign(window, { kept: true }));

  const other = await context.newPage();
  await other.goto("/recordings/rec-login");
  await triggerSessionOn(serviceWorker, other);
  const otherId = await tabIdOf(serviceWorker, other.url());
  await expect.poll(async () => (await sessionSplit(serviceWorker)).partner?.id).toBe(otherId);
  expect(await recordedTabId(serviceWorker)).toBe(otherId);
  expect(await pane.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
  await expect(panelOf(pane)).toContainText("Paused");
});

test("Stop ends the session and closes its pane", async ({ context, page, serviceWorker }) => {
  await page.goto("/");
  await triggerSessionOn(serviceWorker, page);
  await expect.poll(() => sessionPages(context, serviceWorker).length).toBe(1);
  const [pane] = sessionPages(context, serviceWorker);
  await pane?.getByRole("button", { name: "Stop" }).click();

  await expect.poll(() => sessionPages(context, serviceWorker).length).toBe(0);
  expect(await recordedTabId(serviceWorker)).toBeNull();
  expect(page.isClosed()).toBe(false);
});

test("closing the recorded tab ends the session", async ({ context, page, serviceWorker }) => {
  await page.goto("/");
  await triggerSessionOn(serviceWorker, page);
  await expect.poll(() => sessionPages(context, serviceWorker).length).toBe(1);

  await page.close();
  await expect.poll(() => recordedTabId(serviceWorker)).toBeNull();
  await expect.poll(() => sessionPages(context, serviceWorker).length).toBe(0);
});

test("the floating session ignores triggers and returns beside its page when closed", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/");
  await triggerSessionOn(serviceWorker, page);
  await expect.poll(() => sessionPages(context, serviceWorker).length).toBe(1);
  const [pane] = sessionPages(context, serviceWorker);
  if (!pane) throw new Error("No session pane opened.");

  const [pip] = await Promise.all([
    context.waitForEvent("page"),
    pane.getByRole("button", { name: "Float" }).click(),
  ]);
  await expect(panelOf(pip)).toContainText("Recording");
  await expect.poll(async () => (await sessionSplit(serviceWorker)).pane?.splitViewId).toBe(-1);
  const pageId = await tabIdOf(serviceWorker, page.url());
  await expect
    .poll(async () => (await chromeTabs(serviceWorker)).find((tab) => tab.active)?.id)
    .toBe(pageId);

  const other = await context.newPage();
  await other.goto("/recordings/rec-login");
  await triggerSessionOn(serviceWorker, other);
  expect(await recordedTabId(serviceWorker)).toBe(pageId);
  expect((await sessionSplit(serviceWorker)).partner).toBeUndefined();

  await pip.close();
  await expect.poll(async () => (await sessionSplit(serviceWorker)).partner?.id).toBe(pageId);
  await expect(panelOf(pane)).toContainText("Recording");
});

test("the pane opens a new dashboard tab and keeps the session", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/");
  await triggerSessionOn(serviceWorker, page);
  await expect.poll(() => sessionPages(context, serviceWorker).length).toBe(1);
  const [pane] = sessionPages(context, serviceWorker);

  await pane?.getByRole("link", { name: "Open the dashboard" }).click();
  await expect.poll(() => dashboardPages(context, serviceWorker).length).toBe(1);
  expect(sessionPages(context, serviceWorker)).toHaveLength(1);
  expect(await recordedTabId(serviceWorker)).toBe(await tabIdOf(serviceWorker, page.url()));
});

test("typing the session page's address shows that no recording runs", async ({
  page,
  serviceWorker,
}) => {
  await page.goto(new URL("session.html", serviceWorker.url()).href);
  await expect(page.getByRole("status")).toHaveText("No recording is running.");
  await expect(page.getByRole("link", { name: "Open the dashboard" })).toBeVisible();
});

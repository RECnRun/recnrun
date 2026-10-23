import type { BrowserContext, Locator, Page } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  chromeTabs,
  dashboardUrl,
  recordedTabId,
  sessionPages,
  sessionUrl,
  tabIdOf,
} from "./fixtures/tabs.ts";

const FRAME = 'iframe[title="RECnRun dashboard"]';
const SESSION_FRAME = 'iframe[title="RECnRun session"]';

/** The PiP window is a page of its own in Playwright; this waits for the one a click opens. */
async function clickToOpenPanel(context: BrowserContext, click: () => Promise<void>) {
  const [pip] = await Promise.all([context.waitForEvent("page"), click()]);
  return pip;
}

/** The recording panel of the session page that a PiP window frames. */
const panelIn = (pip: Page) =>
  pip.locator(SESSION_FRAME).contentFrame().getByRole("region", { name: "Recording panel" });

const tabItem = (scope: Page | ReturnType<Page["frameLocator"]>, url: string) =>
  scope.getByRole("complementary", { name: "Tabs" }).getByRole("listitem").filter({ hasText: url });

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

/** The panel's logo has loaded, which a blocked or unresolved image URL would not. */
async function expectLogo(panel: Locator) {
  const logo = panel.getByRole("img", { name: "RECnRun" });
  await expect(logo).toBeVisible();
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
}

test("a dashboard tab floats the session over the tab it records", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/recordings/rec-login");
  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl(serviceWorker));
  const site = tabItem(dashboard, page.url());

  const pip = await clickToOpenPanel(context, () =>
    site.getByRole("button", { name: "Float" }).click(),
  );
  await expect(pip.locator(SESSION_FRAME)).toHaveAttribute("src", sessionUrl(serviceWorker));
  await expect(panelIn(pip)).toContainText("Recording");
  await expect(panelIn(pip)).toContainText("00:01");
  await expectLogo(panelIn(pip));
  const siteId = await tabIdOf(serviceWorker, page.url());
  expect(await recordedTabId(serviceWorker)).toBe(siteId);
  await expect
    .poll(async () => (await chromeTabs(serviceWorker)).find((tab) => tab.active)?.id)
    .toBe(siteId);
  expect(sessionPages(context, serviceWorker)).toHaveLength(0);
  await expect(site).toContainText("The session floats in its own window.");

  await panelIn(pip).getByRole("button", { name: "Pause" }).click();
  await expect(site).toContainText("Paused");
  await panelIn(pip).getByRole("button", { name: "Resume" }).click();
  await expect(panelIn(pip)).toContainText("Recording");

  await panelIn(pip).getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
  expect(await recordedTabId(serviceWorker)).toBeNull();
  await expect(site.getByRole("button", { name: "Float" })).toBeVisible();
});

test("the dashboard framed on recnrun.com has the site open the PiP window", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/");
  const dashboard = page.locator(FRAME).contentFrame();
  // requestWindow only works in a top-level window, so the frame cannot open it itself.
  const direct = await dashboard.locator("body").evaluate(() =>
    (
      window as unknown as { documentPictureInPicture: { requestWindow(): Promise<Window> } }
    ).documentPictureInPicture
      .requestWindow()
      .then(
        () => "opened",
        (error: Error) => error.name,
      ),
  );
  expect(direct).toBe("NotAllowedError");

  const pip = await clickToOpenPanel(context, () =>
    tabItem(dashboard, page.url()).getByRole("button", { name: "Float" }).click(),
  );
  await expect(pip.locator(SESSION_FRAME)).toHaveAttribute("src", sessionUrl(serviceWorker));
  await expect(panelIn(pip)).toContainText("Recording");
  await expectLogo(panelIn(pip));
  expect(await recordedTabId(serviceWorker)).toBe(await tabIdOf(serviceWorker, page.url()));
  await panelIn(pip).getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
});

test("stopping the session anywhere closes its PiP window", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/");
  const framed = page.locator(FRAME).contentFrame();
  const pip = await clickToOpenPanel(context, () =>
    tabItem(framed, page.url()).getByRole("button", { name: "Float" }).click(),
  );
  await expect(panelIn(pip)).toContainText("Recording");

  const dashboard = await context.newPage();
  await dashboard.goto(dashboardUrl(serviceWorker));
  await tabItem(dashboard, page.url()).getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
});

import type { BrowserContext, Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

const FRAME = 'iframe[title="RECnRun dashboard"]';

interface ChromeGlobal {
  chrome: {
    runtime: { getURL(path: string): string };
    tabs: { query(filter: { url: string }): Promise<{ active: boolean }[]> };
  };
}

const dashboardUrl = (serviceWorker: Worker) => new URL("dashboard.html", serviceWorker.url()).href;

/** Playwright emulates focus, so every page reports "visible"; Chrome's tab state is the truth. */
function dashboardTabActive(serviceWorker: Worker): Promise<boolean | undefined> {
  return serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const [tab] = await chrome.tabs.query({ url: chrome.runtime.getURL("dashboard.html") });
    return tab?.active;
  });
}

/** The PiP window is a page of its own in Playwright; this waits for the one a click opens. */
async function clickToOpenPanel(context: BrowserContext, click: () => Promise<void>) {
  const [pip] = await Promise.all([context.waitForEvent("page"), click()]);
  return pip;
}

const panelOf = (pip: Page) => pip.getByRole("region", { name: "Recording panel" });

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

test("the dashboard tab opens the panel in a PiP window that outlives a tab switch", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto(dashboardUrl(serviceWorker));
  const pip = await clickToOpenPanel(context, () =>
    page.getByRole("button", { name: "Record" }).click(),
  );
  await expect(panelOf(pip)).toContainText("Recording");
  await expect(panelOf(pip)).toContainText("00:01");

  const target = await context.newPage();
  await target.goto("/");
  await target.bringToFront();
  await expect.poll(() => dashboardTabActive(serviceWorker)).toBe(false);
  expect(pip.isClosed()).toBe(false);

  await pip.getByRole("button", { name: "Pause" }).click();
  await expect(panelOf(pip)).toContainText("Paused");
  await pip.getByRole("button", { name: "Resume" }).click();
  await expect(panelOf(pip)).toContainText("Recording");

  await pip.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect.poll(() => dashboardTabActive(serviceWorker)).toBe(true);
  await expect(page.getByRole("button", { name: "Record" })).toBeVisible();
});

test("closing the PiP window keeps the recording and lets the dashboard reopen it", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto(dashboardUrl(serviceWorker));
  const pip = await clickToOpenPanel(context, () =>
    page.getByRole("button", { name: "Record" }).click(),
  );
  await expect(panelOf(pip)).toContainText("Recording");
  await pip.close();

  await expect(page.getByRole("banner")).toContainText("Recording");
  const reopened = await clickToOpenPanel(context, () =>
    page.getByRole("button", { name: "Show the panel" }).click(),
  );
  await expect(panelOf(reopened)).toContainText("Recording");
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
    dashboard.getByRole("button", { name: "Record" }).click(),
  );
  const panelFrame = pip.locator("iframe").contentFrame();
  await expect(pip.locator("iframe")).toHaveAttribute(
    "src",
    `${dashboardUrl(serviceWorker)}?view=panel`,
  );
  await expect(panelFrame.getByRole("region", { name: "Recording panel" })).toContainText(
    "Recording",
  );
  await panelFrame.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
});

test("while the dashboard tab is open, the site leaves recording to it", async ({
  context,
  page,
  serviceWorker,
}) => {
  const tab = await context.newPage();
  await tab.goto(dashboardUrl(serviceWorker));
  await page.goto("/");
  const site = page.locator(FRAME).contentFrame().getByRole("banner");
  await expect(site).toContainText("Recording is controlled from the RECnRun tab.");
  await expect(site.getByRole("button")).toHaveCount(0);

  await tab.bringToFront();
  const pip = await clickToOpenPanel(context, () =>
    tab.getByRole("button", { name: "Record" }).click(),
  );
  await expect(site).toContainText(/Recording \d\d:\d\d/);
  await expect(site.getByRole("button")).toHaveCount(0);
  await panelOf(pip).getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => pip.isClosed()).toBe(true);

  await tab.close();
  await expect(site.getByRole("button", { name: "Record" })).toBeVisible();
});

test("opening the dashboard tab closes the panel the site opened", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/");
  const site = page.locator(FRAME).contentFrame();
  const pip = await clickToOpenPanel(context, () =>
    site.getByRole("button", { name: "Record" }).click(),
  );
  await expect(pip.locator("iframe").contentFrame().getByRole("region")).toContainText("Recording");

  const tab = await context.newPage();
  await tab.goto(dashboardUrl(serviceWorker));
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect(tab.getByRole("button", { name: "Show the panel" })).toBeVisible();
  await expect(site.getByRole("banner")).toContainText(
    "Recording is controlled from the RECnRun tab.",
  );
});

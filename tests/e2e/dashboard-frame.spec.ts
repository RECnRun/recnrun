import type { Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "../../packages/domain/tests/fixtures.ts";
import { expect, test } from "./fixtures/extension.ts";

const FRAME = 'iframe[title="RECnRun dashboard"]';

/** Echoes every console line into the run log as evidence and keeps the blocking ones. */
function watchConsole(page: Page): string[] {
  const blocked: string[] = [];
  page.on("console", (message) => {
    console.log(`[console:${message.type()}] ${message.text()}`);
    if (/Content Security Policy|Denying load|ERR_BLOCKED/i.test(message.text())) {
      blocked.push(message.text());
    }
  });
  return blocked;
}

const extensionIdOf = (worker: Worker) => new URL(worker.url()).host;

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

test("shows the extension dashboard in a full-viewport frame on the site", async ({
  page,
  serviceWorker,
}) => {
  const blocked = watchConsole(page);
  await page.goto("/");
  const frame = page.locator(FRAME);
  const dashboard = frame.contentFrame();
  await expect(dashboard.getByRole("heading", { name: "RECnRun dashboard" })).toBeVisible();
  await expect(dashboard.getByRole("status")).toHaveText("2 recordings");
  await expect(dashboard.getByRole("link", { name: "Log in as admin" })).toBeVisible();

  const frameUrl = page
    .frames()
    .find((each) => each.url().startsWith("chrome-extension:"))
    ?.url();
  console.log(`[evidence] frame url ${frameUrl} extension id ${extensionIdOf(serviceWorker)}`);
  expect(frameUrl).toMatch(
    new RegExp(`^chrome-extension://${extensionIdOf(serviceWorker)}/dashboard\\.html\\?`),
  );
  const viewport = page.viewportSize();
  expect(await frame.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
  await expect(page).toHaveURL(/localhost:5190\/$/);
  expect(blocked).toEqual([]);
});

test("keeps the dashboard document out of the host page's reach", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.locator(FRAME).contentFrame().getByRole("heading", { name: "RECnRun dashboard" }),
  ).toBeVisible();

  const access = await page.evaluate((selector) => {
    const iframe = document.querySelector<HTMLIFrameElement>(selector);
    let error = "none";
    try {
      void iframe?.contentWindow?.document.body;
    } catch (caught) {
      error = (caught as Error).name;
    }
    return { contentDocument: iframe?.contentDocument ?? null, error, src: iframe?.src ?? "" };
  }, FRAME);
  console.log(`[evidence] host page sees iframe.src ${access.src}`);
  expect(access.contentDocument).toBeNull();
  expect(access.error).toBe("SecurityError");
});

test("uses extension APIs from inside the frame to open a tab", async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.goto("/");
  const dashboard = page.locator(FRAME).contentFrame();
  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    dashboard.getByRole("button", { name: "Open in a new tab" }).click(),
  ]);
  await expect(opened).toHaveURL(
    new RegExp(`^chrome-extension://${extensionIdOf(serviceWorker)}/dashboard\\.html`),
  );
  await expect(opened.getByRole("status")).toHaveText("2 recordings");
});

test("routes site deep links into the dashboard and its navigation back to the address bar", async ({
  baseURL,
  page,
}) => {
  await page.goto("/recordings/rec-login?view=events#t=3");
  const dashboard = page.locator(FRAME).contentFrame();
  await expect(dashboard.getByTestId("route")).toHaveText("/recordings/rec-login?view=events#t=3");
  await expect(dashboard.getByRole("link", { name: "Log in as admin" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await dashboard.getByRole("link", { name: "Checkout with saved card" }).click();
  await expect(page).toHaveURL(`${baseURL}/recordings/rec-checkout`);
  await expect(page).toHaveTitle("Checkout with saved card · RECnRun");

  await page.goBack();
  await expect(dashboard.getByTestId("route")).toHaveText("/recordings/rec-login?view=events#t=3");
});

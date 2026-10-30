import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import {
  APP_HTML,
  APP_ORIGIN,
  callApi,
  EXTENSION_ID,
  groupOf,
  hasApi,
} from "./fixtures/public-api.ts";

const SAVE = 'click [data-testid="save"]';

async function serveApp(context: BrowserContext) {
  await context.route(`${APP_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: APP_HTML }),
  );
}

async function startThroughApi(dashboard: Page, context: BrowserContext) {
  const [app, reply] = await Promise.all([
    context.waitForEvent("page"),
    callApi(dashboard, "startWorkflow", {
      title: "Log in as admin",
      tags: ["env:local", "feature:login"],
      url: `${APP_ORIGIN}/login`,
    }),
  ]);
  if (!reply.ok || reply.result.status !== "recording" || !reply.result.workflow) {
    throw new Error(`Unexpected reply ${JSON.stringify(reply)}`);
  }
  return { app, id: reply.result.workflow.id };
}

/** The recorder reports nothing for this tab, so the step count must stay put. */
async function expectNotRecorded(
  steps: ReturnType<Page["getByRole"]>,
  action: () => Promise<void>,
) {
  const before = await steps.count();
  await action();
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(await steps.count()).toBe(before);
}

test("records a tour started through the public API and shows it live", async ({
  page: dashboard,
  context,
  serviceWorker,
}) => {
  await serveApp(context);
  await dashboard.goto("/");
  await expect(dashboard.getByRole("heading", { name: "No workflows yet" })).toBeVisible();

  const { app, id } = await startThroughApi(dashboard, context);
  await expect(dashboard.getByRole("complementary", { name: "Current recording" })).toContainText(
    "Recording Log in as admin",
  );
  const group = await groupOf(serviceWorker, "http://localhost:");
  expect(group.ids).toHaveLength(1);
  expect(group.ids[0]).not.toBe(-1);
  expect(group.title).toBe("RECnRun");

  await dashboard.getByRole("link", { name: "Log in as admin" }).click();
  const steps = dashboard.getByRole("list", { name: "Steps" }).getByRole("listitem");
  await expect(steps.first()).toContainText(`navigate ${APP_ORIGIN}/login`);

  await app.getByTestId("save").click();
  await app.locator("#email").fill("admin@example.com");
  await app.locator("#password").fill("secret");
  await app.locator("#password").press("Enter");
  await expect(steps).toHaveCount(5);
  await expect(steps.filter({ hasText: SAVE })).toHaveCount(1);
  await expect(steps.filter({ hasText: "fill #email admin@example.com" })).toHaveCount(1);
  await expect(steps.filter({ hasText: "fill #password ***" })).toHaveCount(1);
  await expect(steps.filter({ hasText: "press #password Enter" })).toHaveCount(1);
  await expect(dashboard.getByText("secret")).toHaveCount(0);
  await expect(steps.last().getByText("user", { exact: true })).toBeVisible();

  const outside = await context.newPage();
  await outside.goto(`${APP_ORIGIN}/other`);
  await expectNotRecorded(steps, () => outside.getByTestId("save").click());

  const stopped = await callApi(dashboard, "stopWorkflow", { id });
  expect(stopped).toMatchObject({ ok: true, result: { status: "stopped" } });
  await expect(dashboard.getByText("Stopped")).toBeVisible();
  await expectNotRecorded(steps, () => app.getByTestId("save").click());

  const resumed = await callApi(dashboard, "resumeWorkflow", { id });
  expect(resumed).toMatchObject({ ok: true, result: { status: "recording" } });
  await app.getByTestId("save").click();
  await expect(steps).toHaveCount(6);
  expect(await callApi(dashboard, "stopWorkflow", { id })).toMatchObject({ ok: true });

  await dashboard.getByRole("link", { name: "All workflows" }).click();
  const cards = dashboard.getByRole("article");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("env:local");
  await dashboard.getByRole("searchbox").fill("env:ACC");
  await expect(cards).toHaveCount(0);
  await expect(dashboard.getByText("No workflow matches")).toBeVisible();
});

test("refuses reads through the public API and hides it from other origins", async ({
  page: dashboard,
  context,
}) => {
  await dashboard.goto("/");
  expect(await callApi(dashboard, "getRecordingStatus")).toEqual({
    ok: true,
    result: { missingOrigins: [] },
  });
  // Chrome resolves with nothing when no listener answers: reads stay on the bridge.
  expect(await callApi(dashboard, "listWorkflows")).toBeUndefined();

  await context.route("http://evil.local/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Elsewhere</p>" }),
  );
  const elsewhere = await context.newPage();
  await elsewhere.goto("http://evil.local/");
  expect(await hasApi(elsewhere)).toBe(false);
});

test("starts and stops a recording of the active tab from the popup", async ({
  page: app,
  context,
  serviceWorker,
}) => {
  await serveApp(context);
  const popup = await context.newPage();
  // The id the skill hardcodes must be the one the test build runs under.
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await app.goto(`${APP_ORIGIN}/checkout`);
  await app.bringToFront();

  await popup.getByLabel("Title").fill("Checkout with saved card");
  await popup.getByLabel("Tags").fill("env:ACC feature:checkout");
  await popup.getByRole("button", { name: "Start recording" }).click();
  const recording = popup.getByRole("region", { name: "Current recording" });
  await expect(recording).toContainText("Recording Checkout with saved card");
  expect((await groupOf(serviceWorker, `${APP_ORIGIN}/`)).title).toBe("RECnRun");

  await app.getByTestId("save").click();
  const dashboard = await context.newPage();
  await dashboard.goto("/");
  await dashboard.getByRole("link", { name: "Checkout with saved card" }).click();
  const steps = dashboard.getByRole("list", { name: "Steps" }).getByRole("listitem");
  await expect(steps.filter({ hasText: SAVE })).toHaveCount(1);

  await popup.getByRole("button", { name: "Stop" }).click();
  await expect(popup.getByRole("button", { name: "Start recording" })).toBeVisible();
  await expect(dashboard.getByText("Stopped")).toBeVisible();
});

import { chromium, expect, type Browser, type Page, test } from "@playwright/test";
import {
  FIXTURE_ORIGIN,
  homeWithChrome,
  removeHome,
  startServiceChild,
  storedFlow,
} from "./fixtures/local-service.ts";

const SUBMITTED = "Submitted Ada (free, no contact, terms declined, no file)";

type Fixture = { __fixture?: { ready: boolean; counters: Record<string, number> } };

const countersOf = (page: Page) => page.evaluate(() => (window as Fixture).__fixture?.counters);

/** Every console error and uncaught exception of the UI page. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function checkSetup(ui: Page) {
  await ui.getByRole("link", { name: "Setup" }).click();
  await expect(ui.getByRole("region", { name: "Chrome" })).toContainText("Connected");
  await ui.getByRole("link", { name: "Flows" }).click();
  await expect(ui.getByRole("region", { name: "Flows" })).toContainText("No flows yet.");
}

/** Starts a recording from the catalog and returns the page the service opened in Chrome. */
async function startRecording(ui: Page, chrome: Browser): Promise<Page> {
  const [context] = chrome.contexts();
  if (!context) throw new Error("The recorded Chrome has no default context.");
  await ui.getByRole("button", { name: "New recording" }).click();
  const opened = context.waitForEvent("page");
  await ui.getByRole("button", { name: "Start recording" }).click();
  await expect(ui.getByRole("region", { name: "Recording" })).toContainText("recording");
  const recorded = await opened;
  await recorded.goto(`${FIXTURE_ORIGIN}/routes/form`);
  await recorded.waitForFunction(() => (window as Fixture).__fixture?.ready === true);
  return recorded;
}

/** Picks an element in Chrome through the UI's picker and adds an assertion on it. */
async function pickAssertion(ui: Page, recorded: Page, testId: string, kind: string) {
  const form = ui.getByRole("form", { name: "Add an assertion" });
  await form.getByRole("button", { name: "Pick in Chrome" }).click();
  await expect(form).toContainText("Click the element in Chrome.");
  const box = await recorded.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box.`);
  await recorded.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(form).toContainText(`value="${testId}"`);
  await form.getByRole("combobox", { name: "Kind" }).selectOption(kind);
  if (kind === "textEquals")
    await form
      .getByRole("textbox", { name: "Expected" })
      .fill(await recorded.getByTestId(testId).innerText());
  await form.getByRole("button", { name: "Add assertion" }).click();
}

async function record(ui: Page, chrome: Browser) {
  const recorded = await startRecording(ui, chrome);
  await recorded.getByTestId("name").fill("Ada");
  await recorded.getByTestId("submit").click();
  await expect(recorded.getByTestId("status")).toHaveText(SUBMITTED);
  const suggested = ui.getByRole("list", { name: "Suggested steps" });
  await expect(suggested).toContainText("fill");
  await expect(suggested).toContainText("click");
  await pickAssertion(ui, recorded, "status", "textEquals");
  await pickAssertion(ui, recorded, "submit", "visible");
  // Picking never reaches the application: the one click is the person's submit.
  expect(await countersOf(recorded)).toMatchObject({ clicks: 1, submits: 1 });
  await expect(ui.getByRole("list", { name: "Draft assertions" })).toContainText("textEquals");
  await ui.getByRole("button", { name: "Stop and save" }).click();
}

async function editAndSave(ui: Page) {
  const steps = ui.getByRole("list", { name: "Steps" });
  for (const kind of ["fill", "click", "assert textEquals", "assert visible"])
    await expect(steps).toContainText(kind);
  const timeout = ui.getByRole("listitem", { name: "Step assert-1" }).getByLabel("Timeout (ms)");
  await timeout.fill("10000");
  await timeout.press("Tab");
  await expect(ui.getByText("Unsaved changes")).toBeVisible();
  await ui.getByRole("button", { name: "Save" }).click();
  await expect(ui.getByText("Unsaved changes")).toBeHidden();
  await expect(ui.getByRole("alert")).toHaveCount(0);
}

async function replay(ui: Page, status: string) {
  await ui.getByRole("button", { name: "Run" }).click();
  await ui.getByRole("button", { name: "Start run" }).click();
  const summary = ui.getByRole("region", { name: "Run summary" });
  await expect(summary).toContainText(status, { timeout: 60_000 });
  await expect(ui.getByRole("list", { name: "Step results" })).toContainText("passed");
  return summary;
}

async function addWrongAssertion(ui: Page) {
  const form = ui.getByRole("form", { name: "Add an assertion" });
  await form.getByRole("combobox", { name: "Strategy" }).selectOption("testId");
  await form.getByRole("textbox", { name: "Locator" }).fill("status");
  await form.getByRole("combobox", { name: "Kind" }).selectOption("textEquals");
  await form.getByRole("textbox", { name: "Expected" }).fill("Submitted nobody");
  await form.getByRole("button", { name: "Add assertion" }).click();
  await ui.getByRole("button", { name: "Save" }).click();
  await expect(ui.getByText("Unsaved changes")).toBeHidden();
}

test("records, asserts, survives a restart, and replays a flow from the UI", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  const { home, chrome } = await homeWithChrome();
  const browser = await chromium.connectOverCDP(chrome.wsEndpoint);
  let service = await startServiceChild(home);
  try {
    await page.goto(service.url);
    await checkSetup(page);
    await record(page, browser);
    await editAndSave(page);
    const flowId = decodeURIComponent(new URL(page.url()).hash.split("/")[2] ?? "");
    // Leaving the page first keeps its WebSocket from reporting the service's exit.
    await page.goto("about:blank");
    expect(await service.stop()).toBe(0);

    service = await startServiceChild(home);
    await page.goto(service.url);
    await page
      .getByRole("region", { name: "Flows" })
      .getByRole("button", { name: /^Open / })
      .click();
    const passed = await replay(page, "passed");
    await expect(passed).toContainText("Exit code 0");

    await page.goto(`${service.url}#/flows/${encodeURIComponent(flowId)}`);
    await addWrongAssertion(page);
    const failed = await replay(page, "failed");
    await expect(failed).toContainText("Exit code 1");
    await expect(failed).toContainText('Expected "Submitted nobody", observed "Submitted Ada');

    const stored = await storedFlow(home, flowId);
    expect(stored.yaml).toContain("textEquals");
    expect(stored.revisions.length).toBeGreaterThanOrEqual(3);
    expect(stored.statuses.toSorted()).toEqual(["failed", "passed"]);
    await page.goto("about:blank");
    expect(errors).toEqual([]);
  } finally {
    await service.stop();
    await browser.close();
    await chrome.close();
    await removeHome(home);
  }
});

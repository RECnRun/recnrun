// What the person does in the RECnRun UI and on the fixture, through the same Chrome.
import { expect, type BrowserContext, type Page } from "@playwright/test";

/** The port `playwright.desktop.config.ts` starts the fixture application on. */
const FIXTURE_ORIGIN = "http://127.0.0.1:4600";
const SUBMITTED = "Submitted Ada (free, no contact, terms declined, no file)";

type Fixture = { __fixture?: { ready: boolean } };

/** Starts a recording from the catalog and returns the page the service opened in Chrome. */
export async function startRecording(ui: Page, context: BrowserContext): Promise<Page> {
  await ui.getByRole("button", { name: "New recording" }).click();
  const opened = context.waitForEvent("page");
  await ui.getByRole("button", { name: "Start recording" }).click();
  await expect(ui.getByRole("region", { name: "Recording" })).toContainText("recording", {
    timeout: 30_000,
  });
  return opened;
}

/** Navigates the recorded page to the fixture form, fills it, and submits it. */
export async function useForm(recorded: Page): Promise<void> {
  await recorded.goto(`${FIXTURE_ORIGIN}/routes/form`);
  await recorded.waitForFunction(() => (window as Fixture).__fixture?.ready === true);
  await recorded.getByTestId("name").fill("Ada");
  await recorded.getByTestId("submit").click();
  await expect(recorded.getByTestId("status")).toHaveText(SUBMITTED);
}

/** Picks the status element in Chrome through the UI's picker and asserts its text. */
export async function pickStatusAssertion(ui: Page, recorded: Page): Promise<void> {
  const form = ui.getByRole("form", { name: "Add an assertion" });
  await form.getByRole("button", { name: "Pick in Chrome" }).click();
  await expect(form).toContainText("Click the element in Chrome.", { timeout: 30_000 });
  const box = await recorded.getByTestId("status").boundingBox();
  if (!box) throw new Error("The status element has no box.");
  await recorded.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(form).toContainText('value="status"');
  await form.getByRole("combobox", { name: "Kind" }).selectOption("textEquals");
  await form.getByRole("textbox", { name: "Expected" }).fill(SUBMITTED);
  await form.getByRole("button", { name: "Add assertion" }).click();
  await expect(ui.getByRole("list", { name: "Draft assertions" })).toContainText("textEquals");
}

/** Stops the recording and answers the saved flow's id from the editor's URL. */
export async function stopAndSave(ui: Page): Promise<string> {
  await ui.getByRole("button", { name: "Stop and save" }).click();
  const steps = ui.getByRole("list", { name: "Steps" });
  await expect(steps).toContainText("assert textEquals");
  return decodeURIComponent(new URL(ui.url()).hash.split("/")[2] ?? "");
}

/** Opens the one flow from the catalog and starts a run; answers the replay's own page. */
export async function startRun(ui: Page, context: BrowserContext): Promise<Page> {
  await ui
    .getByRole("region", { name: "Flows" })
    .getByRole("button", { name: /^Open / })
    .click();
  await ui.getByRole("button", { name: "Run" }).click();
  const opened = context.waitForEvent("page", { timeout: 60_000 });
  await ui.getByRole("button", { name: "Start run" }).click();
  return opened;
}

/** Waits for the run to pass and opens its diagnostics; answers the run id. */
export async function expectPassedAndInspect(ui: Page): Promise<string> {
  const summary = ui.getByRole("region", { name: "Run summary" });
  await expect(summary).toContainText("passed", { timeout: 60_000 });
  await expect(summary).toContainText("Exit code 0");
  await expect(ui.getByRole("list", { name: "Step results" })).toContainText("passed");
  await ui.getByRole("button", { name: "Diagnostics" }).click();
  await expect(ui.getByRole("list", { name: "Timeline" })).toContainText("step.started");
  return decodeURIComponent(new URL(ui.url()).hash.replace("#/runs/", ""));
}

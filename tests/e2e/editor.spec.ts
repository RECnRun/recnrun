import { chromium, expect, type Browser, type Page, test } from "@playwright/test";
import {
  FIXTURE_ORIGIN,
  homeWithChrome,
  removeHome,
  startServiceChild,
  storedFlow,
} from "./fixtures/local-service.ts";
import { uiCommand } from "./fixtures/ui-command.ts";

const FLOW_ID = "fixture-form";
const COPY_ID = "fixture-form-copy";
const SUBMITTED = "Submitted Ada (free, no contact, terms declined, no file)";

/** Fills and submits the fixture form, then checks the confirmation. */
const FLOW = {
  schemaVersion: 1,
  id: FLOW_ID,
  name: "Submit the fixture form",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [
    { id: "open", action: "navigate", url: `${FIXTURE_ORIGIN}/routes/form` },
    { id: "name", action: "fill", target: { testId: "name" }, value: "Ada" },
    { id: "submit", action: "click", target: { testId: "submit" } },
    { id: "status", assertion: "textEquals", target: { testId: "status" }, expected: SUBMITTED },
  ],
};

type Fixture = { __fixture?: { ready: boolean } };

const step = (ui: Page, id: string) => ui.getByRole("listitem", { name: `Step ${id}` });

const stepIds = (ui: Page) =>
  ui
    .getByRole("list", { name: "Steps" })
    .getByRole("listitem")
    .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")?.slice(5)));

const short = (revision: string) => revision.slice(0, 12);

/** A full-page screenshot in the test output, kept as the task's record. */
const shot = (ui: Page, name: string) =>
  ui.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

async function save(ui: Page): Promise<string> {
  await ui.getByRole("button", { name: "Save", exact: true }).click();
  await expect(ui.getByText("Unsaved changes")).toBeHidden();
  await expect(ui.getByRole("alert")).toHaveCount(0);
  return ui.getByLabel("Revision", { exact: true }).innerText();
}

/** Appends a wait, moves it before the assertion, and inserts an assertion before the click. */
async function insertAndReorder(ui: Page) {
  const add = ui.getByRole("form", { name: "Add a step" });
  await add.getByRole("combobox", { name: "Action" }).selectOption("waitFor");
  await add.getByRole("combobox", { name: "Strategy" }).selectOption("testId");
  await add.getByRole("textbox", { name: "Locator" }).fill("status");
  await add.getByRole("combobox", { name: "State" }).selectOption("visible");
  await add.getByRole("button", { name: "Add step" }).click();
  await expect.poll(() => stepIds(ui)).toEqual(["open", "name", "submit", "status", "waitFor-1"]);
  await ui.getByRole("button", { name: "Move step waitFor-1 up" }).click();
  const assertion = ui.getByRole("form", { name: "Add an assertion" });
  await assertion
    .getByRole("combobox", { name: "Position" })
    .selectOption({ label: "Before submit" });
  await assertion.getByRole("combobox", { name: "Strategy" }).selectOption("testId");
  await assertion.getByRole("textbox", { name: "Locator" }).fill("submit");
  await assertion.getByRole("combobox", { name: "Kind" }).selectOption("enabled");
  await assertion.getByRole("button", { name: "Add assertion" }).click();
  await expect
    .poll(() => stepIds(ui))
    .toEqual(["open", "name", "assert-1", "submit", "waitFor-1", "status"]);
  const timeout = step(ui, "status").getByLabel("Timeout (ms)");
  await timeout.fill("15000");
  await timeout.press("Tab");
}

/** Turns the typed name into an input, reads it back in the assertion, and declares the rest. */
async function parameterizeAndDeclare(ui: Page) {
  const name = step(ui, "name");
  await name.getByLabel("Value").fill("Grace");
  await name.getByRole("button", { name: "Parameterize step name" }).click();
  await name.getByLabel("Input name").fill("name");
  await name.getByRole("button", { name: "Replace with input" }).click();
  await expect(name.getByLabel("Value")).toHaveValue("${inputs.name}");
  const inputs = ui.getByRole("list", { name: "Inputs" });
  await expect(inputs).toContainText("name");
  await expect(inputs).toContainText("Grace");
  await step(ui, "status")
    .getByLabel("Expected")
    .fill("Submitted ${inputs.name} (free, no contact, terms declined, no file)");
  const requirement = ui.getByRole("form", { name: "Add a requirement" });
  await requirement.getByLabel("Id").fill("CA-01");
  await requirement.getByLabel("Text").fill("The form confirms the submitted name");
  await requirement.getByRole("button", { name: "Add requirement" }).click();
  await step(ui, "status").getByRole("checkbox", { name: "CA-01" }).check();
  const actor = ui.getByRole("form", { name: "Add an actor" });
  await actor.getByLabel("Name").fill("requester");
  await actor.getByRole("button", { name: "Add actor" }).click();
  await step(ui, "open").getByRole("combobox", { name: "Actor" }).selectOption("requester");
}

async function runWithInput(ui: Page, name: string) {
  await ui.getByRole("button", { name: "Run", exact: true }).click();
  const field = ui.getByRole("form", { name: "Inputs" }).getByLabel("name");
  await expect(field).toHaveValue("Grace");
  await field.fill(name);
  await ui.getByRole("button", { name: "Start run" }).click();
  const summary = ui.getByRole("region", { name: "Run summary" });
  await expect(summary).toContainText("passed", { timeout: 60_000 });
  await expect(summary).toContainText("Exit code 0");
}

/** Compares the seeded revision with the edited flow in the Revisions card. */
async function compareRevisions(ui: Page, seeded: string) {
  await ui.getByRole("button", { name: `Compare with ${short(seeded)}` }).click();
  const table = ui.getByRole("table", { name: "Revisions compared" });
  await expect(table.getByRole("row", { name: /^step name / })).toContainText("changed");
  await expect(table.getByRole("row", { name: /^step waitFor-1 / })).toContainText("added");
  await expect(table.getByRole("row", { name: /^step assert-1 / })).toContainText("added");
  await expect(table.getByRole("row", { name: /^step submit / })).toContainText("same");
  await expect(table.getByRole("row", { name: /^field inputs / })).toContainText("changed");
  await expect(table.getByRole("row", { name: /^field requirements / })).toContainText("changed");
}

async function duplicate(ui: Page) {
  const form = ui.getByRole("form", { name: "Duplicate flow" });
  await form.getByLabel("New id").fill(COPY_ID);
  await form.getByLabel("New name").fill("Copy of the fixture form");
  await form.getByRole("button", { name: "Duplicate" }).click();
  await expect(ui).toHaveURL(new RegExp(`#/flows/${COPY_ID}$`));
  await expect(ui.getByRole("heading", { name: "Copy of the fixture form" })).toBeVisible();
  await expect
    .poll(() => stepIds(ui))
    .toEqual(["open", "name", "assert-1", "submit", "waitFor-1", "status"]);
  await ui.getByRole("link", { name: "Flows" }).click();
  const flows = ui.getByRole("region", { name: "Flows" });
  await expect(flows).toContainText("Submit the fixture form");
  await expect(flows).toContainText("Copy of the fixture form");
}

/** Starts a recording so the editor's picker has a page, and opens the form in it. */
async function startRecording(ui: Page, chrome: Browser): Promise<Page> {
  const [context] = chrome.contexts();
  if (!context) throw new Error("The recorded Chrome has no default context.");
  await ui.getByRole("link", { name: "Record" }).click();
  const opened = context.waitForEvent("page");
  await ui.getByRole("button", { name: "Start recording" }).click();
  await expect(ui.getByRole("region", { name: "Recording" })).toContainText("recording");
  const recorded = await opened;
  await recorded.goto(`${FIXTURE_ORIGIN}/routes/form`);
  await recorded.waitForFunction(() => (window as Fixture).__fixture?.ready === true);
  return recorded;
}

/** Picks the name field in Chrome and chooses the second candidate the picker lists. */
async function pickSecondCandidate(ui: Page, recorded: Page, base: string) {
  await ui.goto(`${base}#/flows/${COPY_ID}`);
  const form = ui.getByRole("form", { name: "Add an assertion" });
  await form.getByRole("button", { name: "Pick in Chrome" }).click();
  await expect(form).toContainText("Click the element in Chrome.");
  const box = await recorded.getByTestId("name").boundingBox();
  if (!box) throw new Error("The name field has no box.");
  await recorded.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const candidates = form.getByRole("radiogroup", { name: "Candidates" });
  await expect(candidates.getByRole("radio")).toHaveCount(2);
  await expect(candidates).toContainText('testId value="name"');
  await expect(candidates).toContainText("input[name=");
  await candidates.getByRole("radio").nth(1).check();
  await form.getByRole("combobox", { name: "Kind" }).selectOption("visible");
  await form.getByRole("button", { name: "Add assertion" }).click();
  const added = step(ui, "assert-2");
  await expect(added).toContainText("assert visible");
  await expect(added).toContainText("input[name=");
  await expect(added).not.toContainText("testId");
}

test("edits every part of a flow as new revisions that past runs keep", async ({ page }) => {
  test.setTimeout(240_000);
  const { home, chrome } = await homeWithChrome();
  const browser = await chromium.connectOverCDP(chrome.wsEndpoint);
  const service = await startServiceChild(home);
  try {
    await page.goto(service.url);
    const seeded = await uiCommand<{ revision: string }>(page, "flow.import", { flow: FLOW });
    await page.goto(`${service.url}#/flows/${FLOW_ID}`);
    await insertAndReorder(page);
    await parameterizeAndDeclare(page);
    await shot(page, "declared");
    const edited = await save(page);
    expect(edited).not.toBe(short(seeded.revision));
    await runWithInput(page, "Ada");

    await page.goto(`${service.url}#/flows/${FLOW_ID}`);
    const open = step(page, "open").getByLabel("Timeout (ms)");
    await open.fill("20000");
    await open.press("Tab");
    const again = await save(page);
    expect(again).not.toBe(edited);
    const stored = await storedFlow(home, FLOW_ID);
    expect(stored.revisions).toHaveLength(3);
    expect(stored.statuses).toEqual(["passed"]);
    // The run keeps the revision it replayed; the later save never rewrites it.
    expect(stored.runRevisions.map(short)).toEqual([edited]);
    expect(stored.yaml).toContain("${inputs.name}");
    expect(stored.yaml).toContain("CA-01");
    await compareRevisions(page, seeded.revision);
    await shot(page, "compared");
    await duplicate(page);

    const recorded = await startRecording(page, browser);
    await pickSecondCandidate(page, recorded, service.url);
    await shot(page, "picked");
    await page.goto("about:blank");
  } finally {
    await service.stop();
    await browser.close();
    await chrome.close();
    await removeHome(home);
  }
});

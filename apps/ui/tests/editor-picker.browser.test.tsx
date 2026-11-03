import type { Flow, FlowManifest, LocatorList, SessionStatus } from "@recnrun/protocol";
import { render } from "preact";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { Editor } from "@/features/editor/Editor";
import { NOW, REVISION, expectTexts, fakeApi, renderWith } from "./fake-api";

const LEASE = {
  leaseId: "lease-1",
  fencingToken: 3,
  targetId: "tab-1",
  holderId: "ui",
  kind: "manual" as const,
  acquiredAt: 1,
  expiresAt: 2,
};

const STATUS: SessionStatus = {
  sessionId: "session-1",
  state: "recording",
  control: "unassigned",
  pauses: { pauseStepCreation: "active", pauseReplay: "active", suspendCapture: "active" },
  lease: LEASE,
};

const FLOW: Flow = {
  schemaVersion: 1,
  id: "form",
  name: "Submit the form",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [
    { id: "open", action: "navigate", url: "http://localhost:4600/routes/form" },
    { id: "name", action: "fill", target: { testId: "name" }, value: "Ada" },
  ],
};

const MANIFEST: FlowManifest = {
  schemaVersion: 1,
  id: "form",
  name: "Submit the form",
  revision: REVISION,
  status: "recorded",
  createdAt: NOW,
  updatedAt: NOW,
  revisions: [{ revision: REVISION, savedAt: NOW }],
};

/** What the engine suggests for the fixture's name field: its test id, then its name attribute. */
const PICKED: LocatorList = {
  resolution: "orderedFallback",
  cardinality: "one",
  locators: [
    { strategy: "testId", value: "name" },
    { strategy: "css", value: 'input[name="name"]' },
  ],
};

function editor(sessionId: string | undefined, status: SessionStatus = STATUS) {
  const fake = fakeApi({
    "flow.get": () => ({ flow: FLOW, manifest: MANIFEST, revision: REVISION }),
    "flow.save": ({ flow }) => ({ flowId: flow.id, revision: "b".repeat(64) }),
    "session.status": () => status,
    "picker.start": ({ sessionId: id }) => ({ sessionId: id, picking: true }),
    "picker.stop": ({ sessionId: id }) => ({ sessionId: id, picking: false }),
  });
  const root = renderWith(
    fake.api,
    <Editor flowId="form" sessionId={sessionId} onRun={vi.fn()} onDuplicated={vi.fn()} />,
  );
  return { ...fake, root };
}

const form = () => page.getByRole("form", { name: "Add an assertion" });
const candidates = () => form().getByRole("radiogroup", { name: "Candidates" });

function pick(fake: ReturnType<typeof editor>, sessionId = "session-1") {
  fake.emit("picker.picked", {
    type: "picker.picked",
    sessionId,
    target: { tag: "input", name: "name", testId: "name" },
    locators: PICKED,
  });
}

test("lists the pick's candidates and adds an assertion on the chosen one", async () => {
  const fake = editor("session-1");
  await form().getByRole("button", { name: "Pick in Chrome" }).click();
  await expect.element(form().getByText("Click the element in Chrome.")).toBeVisible();
  const start = fake.calls.find((call) => call.command === "picker.start");
  expect(start?.params).toEqual({ sessionId: "session-1" });
  expect(start?.options?.lease).toMatchObject({ leaseId: "lease-1", fencingToken: 3 });
  pick(fake, "other");
  expect(candidates().query()).toBeNull();
  pick(fake);
  await expect.poll(() => candidates().getByRole("radio").all().length).toBe(2);
  await expectTexts(candidates(), 'testId value="name"', 'css value="input[name=\\"name\\"]"');
  await expect.element(candidates().getByRole("radio").nth(0)).toBeChecked();
  expect(fake.paramsOf("picker.stop")).toEqual([{ sessionId: "session-1" }]);
  await candidates().getByRole("radio").nth(1).click();
  await form().getByRole("combobox", { name: "Kind" }).selectOptions("value");
  await form().getByRole("textbox", { name: "Expected" }).fill("Ada");
  await form().getByRole("button", { name: "Add assertion" }).click();
  const added = page.getByRole("listitem", { name: "Step assert-1" });
  await expectTexts(added, "assert value", 'css="input[name=\\"name\\"]"');
  await expect.element(added.getByLabelText("Expected")).toHaveValue("Ada");
  expect(added.getByText("testId", { exact: false }).query()).toBeNull();
  // The form is clear for the next assertion: no candidates linger.
  await expect.poll(() => candidates().query()).toBeNull();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fake.paramsOf("flow.save").length).toBe(1);
  const [saved] = fake.paramsOf("flow.save") as { flow: Flow }[];
  expect(saved?.flow.steps.at(-1)).toEqual({
    id: "assert-1",
    assertion: "value",
    target: { css: 'input[name="name"]' },
    expected: "Ada",
  });
});

test("clears the candidates to type a locator instead", async () => {
  const fake = editor("session-1");
  await form().getByRole("button", { name: "Pick in Chrome" }).click();
  pick(fake);
  await expect.poll(() => candidates().getByRole("radio").all().length).toBe(2);
  await expect.element(form().getByRole("button", { name: "Add assertion" })).toBeEnabled();
  await form().getByRole("button", { name: "Clear" }).click();
  await expect.poll(() => candidates().query()).toBeNull();
  await expect.element(form().getByRole("button", { name: "Add assertion" })).toBeDisabled();
  await form().getByRole("combobox", { name: "Strategy" }).selectOptions("label");
  await form().getByRole("textbox", { name: "Locator" }).fill("Name");
  await form().getByRole("button", { name: "Add assertion" }).click();
  await expectTexts(page.getByRole("listitem", { name: "Step assert-1" }), 'label="Name"');
});

test("cancels a pick and stops the picker when leaving the screen mid-pick", async () => {
  const fake = editor("session-1");
  await form().getByRole("button", { name: "Pick in Chrome" }).click();
  await form().getByRole("button", { name: "Cancel picking" }).click();
  await expect.element(form().getByRole("button", { name: "Pick in Chrome" })).toBeVisible();
  expect(fake.paramsOf("picker.stop")).toEqual([{ sessionId: "session-1" }]);
  await form().getByRole("button", { name: "Pick in Chrome" }).click();
  await expect.element(form().getByRole("button", { name: "Cancel picking" })).toBeVisible();
  render(null, fake.root);
  await expect.poll(() => fake.paramsOf("picker.stop").length).toBe(2);
});

test("offers no picker without a live session of this tab", async () => {
  const idle = editor(undefined);
  await expect
    .element(page.getByText("Pick elements in Chrome while recording; here, type a locator."))
    .toBeVisible();
  expect(idle.calls.map(({ command }) => command)).toEqual(["flow.get"]);
  editor("session-1", { ...STATUS, state: "completed" });
  await expect
    .element(page.getByText("Pick elements in Chrome while recording; here, type a locator."))
    .toBeVisible();
  expect(page.getByRole("button", { name: "Pick in Chrome" }).query()).toBeNull();
});

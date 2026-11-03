import type { Flow, FlowManifest, Step } from "@recnrun/protocol";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { Editor } from "@/features/editor/Editor";
import {
  EMPTY_ACTION,
  buildAction,
  insertStep,
  moveStep,
  setStepField,
} from "@/features/editor/edit";
import { NOW, REVISION, expectTexts, fakeApi, renderWith } from "./fake-api";

const FLOW: Flow = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [
    { id: "open", action: "navigate", url: "http://localhost:4600/login" },
    { id: "email", action: "fill", target: { label: "Email" }, value: "${inputs.email}" },
    { id: "password", action: "fill", target: { css: "#password" }, value: "${secrets.pw}" },
    { id: "count", assertion: "count", target: { css: ".error" }, expected: 0 },
  ],
};

const MANIFEST: FlowManifest = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  revision: REVISION,
  status: "recorded",
  createdAt: NOW,
  updatedAt: NOW,
  revisions: [{ revision: REVISION, savedAt: NOW }],
};

function editor() {
  const fake = fakeApi({
    "flow.get": () => ({ flow: FLOW, manifest: MANIFEST, revision: REVISION }),
    "flow.save": ({ flow }) => ({ flowId: flow.id, revision: "b".repeat(64) }),
  });
  renderWith(fake.api, <Editor flowId="login" onRun={vi.fn()} />);
  return fake;
}

const step = (id: string) => page.getByRole("listitem", { name: `Step ${id}` });

const stepIds = () =>
  page
    .getByRole("list", { name: "Steps" })
    .getByRole("listitem")
    .all()
    .map((item) => item.element().getAttribute("aria-label")?.slice(5));

async function saved(fake: ReturnType<typeof editor>): Promise<Flow> {
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fake.paramsOf("flow.save").length).toBe(1);
  const [params] = fake.paramsOf("flow.save") as { flow: Flow }[];
  return params?.flow as Flow;
}

test("moves steps up and down within the flow", async () => {
  const fake = editor();
  await expect.element(page.getByRole("button", { name: "Move step open up" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Move step count down" })).toBeDisabled();
  await page.getByRole("button", { name: "Move step password up" }).click();
  await expect.poll(stepIds).toEqual(["open", "password", "email", "count"]);
  await page.getByRole("button", { name: "Move step open down" }).click();
  await expect.poll(stepIds).toEqual(["password", "open", "email", "count"]);
  await expect.element(page.getByText("Unsaved changes")).toBeVisible();
  const flow = await saved(fake);
  expect(flow.steps.map(({ id }) => id)).toEqual(["password", "open", "email", "count"]);
});

test("inserts a wait and an assertion before chosen steps", async () => {
  const fake = editor();
  const form = page.getByRole("form", { name: "Add a step" });
  await expect.element(form.getByRole("button", { name: "Add step" })).toBeDisabled();
  await form.getByRole("combobox", { name: "Action" }).selectOptions("waitFor");
  await form.getByRole("combobox", { name: "Position" }).selectOptions("Before password");
  await form.getByRole("combobox", { name: "Strategy" }).selectOptions("testId");
  await form.getByRole("textbox", { name: "Locator" }).fill("password");
  await form.getByRole("combobox", { name: "State" }).selectOptions("attached");
  await form.getByRole("button", { name: "Add step" }).click();
  await expect.poll(stepIds).toEqual(["open", "email", "waitFor-1", "password", "count"]);
  await expectTexts(step("waitFor-1"), "waitFor", 'testId="password"');
  const assertion = page.getByRole("form", { name: "Add an assertion" });
  await assertion.getByRole("combobox", { name: "Position" }).selectOptions("Before email");
  await assertion.getByRole("combobox", { name: "Kind" }).selectOptions("url");
  expect(assertion.getByRole("combobox", { name: "Strategy" }).query()).toBeNull();
  await assertion.getByRole("textbox", { name: "Expected" }).fill("/login");
  await assertion.getByRole("button", { name: "Add assertion" }).click();
  await expect
    .poll(stepIds)
    .toEqual(["open", "assert-1", "email", "waitFor-1", "password", "count"]);
  const flow = await saved(fake);
  expect(flow.steps[1]).toEqual({ id: "assert-1", assertion: "url", expected: "/login" });
  expect(flow.steps[3]).toEqual({
    id: "waitFor-1",
    action: "waitFor",
    target: { testId: "password" },
    state: "attached",
  });
});

test("adds a key press without a target and a click with one", async () => {
  const fake = editor();
  const form = page.getByRole("form", { name: "Add a step" });
  await form.getByRole("combobox", { name: "Action" }).selectOptions("keyPress");
  await form.getByRole("textbox", { name: "Key" }).fill("Enter");
  await form.getByRole("button", { name: "Add step" }).click();
  await form.getByRole("combobox", { name: "Action" }).selectOptions("click");
  await expect.element(form.getByRole("button", { name: "Add step" })).toBeDisabled();
  await form.getByRole("combobox", { name: "Strategy" }).selectOptions("text");
  await form.getByRole("textbox", { name: "Locator" }).fill("Sign in");
  await form.getByRole("button", { name: "Add step" }).click();
  await expect
    .poll(stepIds)
    .toEqual(["open", "email", "password", "count", "keyPress-1", "click-1"]);
  const flow = await saved(fake);
  expect(flow.steps.slice(4)).toEqual([
    { id: "keyPress-1", action: "keyPress", key: "Enter" },
    { id: "click-1", action: "click", target: { text: "Sign in" } },
  ]);
});

test("edits a step's url, value, expected count, and target in place", async () => {
  const fake = editor();
  await step("open").getByLabelText("URL").fill("http://localhost:4600/signin");
  await step("email").getByLabelText("Value").fill("ada@example.com");
  await step("count").getByLabelText("Expected").fill("2");
  expect(step("open").getByLabelText("Value").query()).toBeNull();
  await step("password").getByRole("button", { name: "Change target of password" }).click();
  const target = step("password");
  await expect.element(target.getByRole("button", { name: "Apply target" })).toBeDisabled();
  await target.getByRole("combobox", { name: "Strategy" }).selectOptions("testId");
  await target.getByRole("textbox", { name: "Locator" }).fill("pw");
  await target.getByRole("button", { name: "Apply target" }).click();
  await expectTexts(target, 'testId="pw"');
  expect(target.getByRole("textbox", { name: "Locator" }).query()).toBeNull();
  const flow = await saved(fake);
  expect(flow.steps[0]).toMatchObject({ url: "http://localhost:4600/signin" });
  expect(flow.steps[1]).toMatchObject({ value: "ada@example.com" });
  expect(flow.steps[2]).toMatchObject({ target: { testId: "pw" }, value: "${secrets.pw}" });
  expect(flow.steps[3]).toMatchObject({ expected: 2 });
});

test("builds steps from the form's fields and edits them without touching the rest", () => {
  const ids = (flow: Flow) => flow.steps.map(({ id }) => id);
  expect(ids(moveStep(FLOW, "open", -1))).toEqual(ids(FLOW));
  expect(ids(moveStep(FLOW, "count", 1))).toEqual(ids(FLOW));
  expect(ids(moveStep(FLOW, "missing", 1))).toEqual(ids(FLOW));
  const wait: Step = { id: "w", action: "waitFor", url: "/done" };
  expect(ids(insertStep(FLOW, wait, "nowhere"))).toEqual([
    "open",
    "email",
    "password",
    "count",
    "w",
  ]);
  expect(ids(insertStep(FLOW, wait, "open"))).toEqual(["w", "open", "email", "password", "count"]);
  const untimed = setStepField(
    setStepField(FLOW, "open", "timeoutMs", 5),
    "open",
    "timeoutMs",
    undefined,
  );
  expect(untimed.steps[0]).toEqual(FLOW.steps[0]);
  expect(buildAction("n", EMPTY_ACTION)).toBeUndefined();
  expect(buildAction("n", { ...EMPTY_ACTION, url: "/a" })).toEqual({
    id: "n",
    action: "navigate",
    url: "/a",
  });
  expect(buildAction("f", { ...EMPTY_ACTION, action: "fill", target: "#a", value: "x" })).toEqual({
    id: "f",
    action: "fill",
    target: "#a",
    value: "x",
  });
  expect(buildAction("f", { ...EMPTY_ACTION, action: "fill", value: "x" })).toBeUndefined();
  expect(
    buildAction("k", { ...EMPTY_ACTION, action: "keyPress", key: "Tab", target: "#a" }),
  ).toEqual({
    id: "k",
    action: "keyPress",
    key: "Tab",
    target: "#a",
  });
  expect(buildAction("w", { ...EMPTY_ACTION, action: "waitFor" })).toBeUndefined();
  expect(
    buildAction("w", { ...EMPTY_ACTION, action: "waitFor", url: "/done", state: "hidden" }),
  ).toEqual({
    id: "w",
    action: "waitFor",
    url: "/done",
  });
});

import type { Flow, FlowManifest } from "@recnrun/protocol";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  addInput,
  parameterize,
  parseDefault,
  removeActor,
  removeRequirement,
  toggleRequirement,
} from "@/features/editor/declare";
import { Editor } from "@/features/editor/Editor";
import { NOW, REVISION, expectTexts, fakeApi, renderWith } from "./fake-api";

const FLOW: Flow = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  actors: {},
  inputs: { email: { type: "string", required: true } },
  requirements: [{ id: "CA-01", text: "Users sign in with their email" }],
  preconditions: [],
  steps: [
    { id: "open", action: "navigate", url: "http://localhost:4600/login" },
    { id: "email", action: "fill", target: { label: "Email" }, value: "${inputs.email}" },
    { id: "password", action: "fill", target: { css: "#password" }, value: "hunter2" },
    { id: "done", assertion: "visible", target: { testId: "welcome" }, requirements: ["CA-01"] },
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
  renderWith(fake.api, <Editor flowId="login" onRun={vi.fn()} onDuplicated={vi.fn()} />);
  return fake;
}

const step = (id: string) => page.getByRole("listitem", { name: `Step ${id}` });
const list = (name: string) => page.getByRole("list", { name });
const form = (name: string) => page.getByRole("form", { name });

async function saved(fake: ReturnType<typeof editor>): Promise<Flow> {
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fake.paramsOf("flow.save").length).toBe(1);
  const [params] = fake.paramsOf("flow.save") as { flow: Flow }[];
  return params?.flow as Flow;
}

test("declares inputs with typed defaults and refuses bad names and values", async () => {
  const fake = editor();
  await expectTexts(list("Inputs"), "email", "string");
  const add = form("Add an input");
  await expect.element(add.getByRole("button", { name: "Add input" })).toBeDisabled();
  await add.getByRole("textbox", { name: "Name" }).fill("9lives");
  await add.getByRole("button", { name: "Add input" }).click();
  await expectTexts(add, "A name is an identifier (letters, digits, underscore).");
  await add.getByRole("textbox", { name: "Name" }).fill("email");
  await add.getByRole("button", { name: "Add input" }).click();
  await expectTexts(add, "An input named email exists already.");
  await add.getByRole("textbox", { name: "Name" }).fill("attempts");
  await add.getByRole("combobox", { name: "Type" }).selectOptions("number");
  await add.getByRole("textbox", { name: "Default" }).fill("many");
  await add.getByRole("button", { name: "Add input" }).click();
  await expectTexts(add, "The default must be a number.");
  await add.getByRole("textbox", { name: "Default" }).fill("3");
  await add.getByRole("button", { name: "Add input" }).click();
  await expectTexts(list("Inputs"), "attempts", "number", "3");
  await expect.element(add.getByRole("textbox", { name: "Name" })).toHaveValue("");
  await page.getByRole("button", { name: "Remove input email" }).click();
  const flow = await saved(fake);
  expect(flow.inputs).toEqual({ attempts: { type: "number", required: false, default: 3 } });
});

test("declares actors and requirements and links them to steps", async () => {
  const fake = editor();
  await expect.element(page.getByText("No actors yet.")).toBeVisible();
  expect(step("open").getByRole("combobox", { name: "Actor" }).query()).toBeNull();
  const actor = form("Add an actor");
  await actor.getByRole("textbox", { name: "Name" }).fill("requester");
  await actor.getByRole("textbox", { name: "Description" }).fill("Files the request");
  await actor.getByRole("button", { name: "Add actor" }).click();
  await expectTexts(list("Actors"), "requester", "Files the request");
  await step("open").getByRole("combobox", { name: "Actor" }).selectOptions("requester");
  const requirement = form("Add a requirement");
  await requirement.getByRole("textbox", { name: "Id" }).fill("CA 02");
  await requirement.getByRole("textbox", { name: "Text" }).fill("Wrong passwords are refused");
  await requirement.getByRole("button", { name: "Add requirement" }).click();
  await expectTexts(requirement, "An id starts with a letter or digit and has no spaces.");
  await requirement.getByRole("textbox", { name: "Id" }).fill("CA-02");
  await requirement.getByRole("button", { name: "Add requirement" }).click();
  await expectTexts(list("Requirements"), "CA-02", "Wrong passwords are refused");
  await expect.element(step("done").getByRole("checkbox", { name: "CA-01" })).toBeChecked();
  await step("password").getByRole("checkbox", { name: "CA-02" }).click();
  await step("done").getByRole("checkbox", { name: "CA-01" }).click();
  await page.getByRole("button", { name: "Remove requirement CA-01" }).click();
  await expect
    .poll(() => step("password").getByRole("checkbox", { name: "CA-01" }).query())
    .toBeNull();
  const flow = await saved(fake);
  expect(flow.actors).toEqual({ requester: { description: "Files the request" } });
  expect(flow.requirements).toEqual([{ id: "CA-02", text: "Wrong passwords are refused" }]);
  expect(flow.steps[0]?.actor).toBe("requester");
  expect(flow.steps[2]?.requirements).toEqual(["CA-02"]);
  expect(flow.steps[3]).not.toHaveProperty("requirements");
});

test("parameterizes a literal value into an input with that default", async () => {
  const fake = editor();
  expect(step("open").getByRole("button", { name: "Parameterize step open" }).query()).toBeNull();
  // A reference is not a literal: nothing to parameterize.
  expect(step("email").getByRole("button", { name: "Parameterize step email" }).query()).toBeNull();
  await step("password").getByRole("button", { name: "Parameterize step password" }).click();
  const replace = step("password").getByRole("button", { name: "Replace with input" });
  await expect.element(replace).toBeDisabled();
  await step("password").getByLabelText("Input name").fill("pw");
  await replace.click();
  await expect.element(step("password").getByLabelText("Value")).toHaveValue("${inputs.pw}");
  await expectTexts(list("Inputs"), "pw", '"hunter2"');
  await expect.poll(() => step("password").getByLabelText("Input name").query()).toBeNull();
  const flow = await saved(fake);
  expect(flow.inputs.pw).toEqual({ type: "string", required: false, default: "hunter2" });
  expect(flow.steps[2]).toMatchObject({ value: "${inputs.pw}" });
});

test("edits declarations purely and keeps the steps consistent", () => {
  expect(parseDefault("string", "")).toBeUndefined();
  expect(parseDefault("boolean", "true")).toBe(true);
  expect(parseDefault("boolean", "no")).toBe(false);
  expect(parseDefault("array", '["a"]')).toEqual(["a"]);
  expect(parseDefault("object", '{"a":1}')).toEqual({ a: 1 });
  expect(() => parseDefault("object", "{")).toThrow("The default must be JSON (object).");
  expect(() => parseDefault("number", "x")).toThrow("The default must be a number.");
  const acted: Flow = {
    ...FLOW,
    actors: { a: {} },
    steps: FLOW.steps.map((step) => ({ ...step, actor: "a" })),
  };
  const without = removeActor(acted, "a");
  expect(without.actors).toEqual({});
  expect(without.steps.every((step) => !("actor" in step))).toBe(true);
  const unlinked = removeRequirement(FLOW, "CA-01");
  expect(unlinked.requirements).toEqual([]);
  expect(unlinked.steps[3]).not.toHaveProperty("requirements");
  const linked = toggleRequirement(FLOW, "open", "CA-01");
  expect(linked.steps[0]?.requirements).toEqual(["CA-01"]);
  expect(toggleRequirement(linked, "open", "CA-01").steps[0]).toEqual(FLOW.steps[0]);
  expect(parameterize(FLOW, "open", "x")).toBe(FLOW);
  // An input declared without a default must be given at run time; parameterizing keeps it.
  const declared = addInput(FLOW, "pw", { type: "string" });
  expect(parameterize(declared, "password", "pw").inputs.pw).toEqual({
    type: "string",
    required: true,
  });
});

import type { Flow, FlowManifest } from "@recnrun/protocol";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { ApiError } from "@/api/error";
import { Editor } from "@/features/editor/Editor";
import { buildAssertion, nextAssertionId, setTimeoutMs } from "@/features/editor/edit";
import { NOW, REVISION, expectTexts, fakeApi, renderWith } from "./fake-api";

const SAVED = "b".repeat(64);
const EMAIL = { resolution: "orderedFallback", cardinality: "one", locators: [{ label: "Email" }] };

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
    { id: "email", action: "fill", target: EMAIL, value: "${inputs.email}" },
    { id: "password", action: "fill", target: { css: "#password" }, value: "${secrets.pw}" },
  ],
} as Flow;

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

function editor(flow: Flow = FLOW) {
  const fake = fakeApi({
    "flow.get": () => ({ flow, manifest: MANIFEST, revision: REVISION }),
    "flow.save": ({ flow: saved }) => ({ flowId: saved.id, revision: SAVED }),
  });
  const onRun = vi.fn<() => void>();
  renderWith(fake.api, <Editor flowId="login" onRun={onRun} />);
  return { ...fake, onRun };
}

const steps = () => page.getByRole("list", { name: "Steps" }).getByRole("listitem");

test("shows each step with its action, target, value, and timeout", async () => {
  editor();
  await expect.element(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await expect.poll(() => steps().all().length).toBe(3);
  await expectTexts(steps().nth(1), "fill", 'label="Email"', "${inputs.email}");
  await expectTexts(steps().nth(2), 'css="#password"', "${secrets.pw}");
  await expect.element(page.getByLabelText("Revision")).toHaveTextContent("aaaaaaaaaaaa");
  await expect.element(steps().nth(0).getByLabelText("Timeout (ms)")).toHaveValue(null);
});

test("deletes a step, sets a timeout, and saves the edited flow", async () => {
  const fake = editor();
  await page.getByRole("button", { name: "Delete step email" }).click();
  await expect.poll(() => steps().all().length).toBe(2);
  await page
    .getByRole("listitem", { name: "Step open" })
    .getByLabelText("Timeout (ms)")
    .fill("900");
  await expect.element(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.element(page.getByLabelText("Revision")).toHaveTextContent("bbbbbbbbbbbb");
  await expect.element(page.getByText("Unsaved changes")).not.toBeInTheDocument();
  const [saved] = fake.paramsOf("flow.save") as { flow: Flow }[];
  expect(saved?.flow.steps.map((step) => step.id)).toEqual(["open", "password"]);
  expect(saved?.flow.steps[0]?.timeoutMs).toBe(900);
});

test("adds an assertion from the form and saves the flow alone", async () => {
  const fake = editor();
  await expect.element(page.getByRole("button", { name: "Add assertion" })).toBeDisabled();
  await page.getByRole("combobox", { name: "Strategy" }).selectOptions("testId");
  await page.getByRole("textbox", { name: "Locator" }).fill("welcome");
  await page.getByRole("combobox", { name: "Kind" }).selectOptions("textContains");
  await page.getByRole("textbox", { name: "Expected" }).fill("Welcome");
  await page.getByRole("button", { name: "Add assertion" }).click();
  await expectTexts(steps().nth(3), "assert textContains", "assert-1", 'testId="welcome"');
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fake.paramsOf("flow.save").length).toBe(1);
  const [saved] = fake.paramsOf("flow.save") as { flow: Flow }[];
  expect(Object.keys(saved ?? {})).toEqual(["flow"]);
  expect(saved?.flow.steps.at(-1)).toEqual({
    id: "assert-1",
    assertion: "textContains",
    target: { testId: "welcome" },
    expected: "Welcome",
  });
});

test("offers no picker outside a recording", async () => {
  const fake = editor();
  await expect
    .element(page.getByText("Pick elements in Chrome while recording; here, type a locator."))
    .toBeVisible();
  expect(page.getByRole("button", { name: "Pick in Chrome" }).query()).toBeNull();
  await page.getByRole("combobox", { name: "Strategy" }).selectOptions("text");
  await page.getByRole("textbox", { name: "Locator" }).fill("Signed in");
  await page.getByRole("button", { name: "Add assertion" }).click();
  await expectTexts(steps().nth(3), "assert visible", 'text="Signed in"');
  expect(fake.calls.map(({ command }) => command)).toEqual(["flow.get"]);
});

test("builds assertions and ids the flow does not use yet", () => {
  const flow = { ...FLOW, steps: [...FLOW.steps, buildAssertion("assert-1", "visible", "#a", "")] };
  expect(nextAssertionId(flow)).toBe("assert-2");
  expect(buildAssertion("c", "count", "#a", "3")).toEqual({
    id: "c",
    assertion: "count",
    target: "#a",
    expected: 3,
  });
  const timed = setTimeoutMs(FLOW, "open", 500);
  expect(setTimeoutMs(timed, "open", undefined).steps[0]).toEqual(FLOW.steps[0]);
});

test("shows an empty flow and the service's errors", async () => {
  const fake = editor({ ...FLOW, steps: [] });
  await expect.element(page.getByText("This flow has no steps yet.")).toBeVisible();
  fake.handlers["flow.save"] = () => {
    throw new ApiError("revision-conflict", "The flow changed since you opened it.");
  };
  await page.getByRole("button", { name: "Save" }).click();
  await expectTexts(
    page.getByRole("alert"),
    "The flow changed since you opened it.",
    "revision-conflict",
  );
  fake.handlers["flow.get"] = () => {
    throw new ApiError("flow-not-found", "No flow login.");
  };
  renderWith(fake.api, <Editor flowId="login" onRun={fake.onRun} />);
  await expectTexts(page.getByRole("alert"), "No flow login.", "flow-not-found");
});

test("opens the run screen", async () => {
  const fake = editor();
  await page.getByRole("button", { name: "Run" }).click();
  expect(fake.onRun).toHaveBeenCalledOnce();
});

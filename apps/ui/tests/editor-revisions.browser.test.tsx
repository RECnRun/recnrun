import type { Flow, FlowManifest } from "@recnrun/protocol";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { ApiError } from "@/api/error";
import { compareFlows } from "@/features/editor/diff";
import { Editor } from "@/features/editor/Editor";
import { NOW, REVISION, expectTexts, fakeApi, renderWith } from "./fake-api";

const FIRST = "1".repeat(64);
const SAVED = "b".repeat(64);
const EARLIER = "2026-11-01T09:00:00.000Z";

const FLOW: Flow = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  actors: {},
  inputs: { email: { type: "string", required: true } },
  requirements: [],
  preconditions: [],
  steps: [
    { id: "open", action: "navigate", url: "http://localhost:4600/login" },
    { id: "email", action: "fill", target: { label: "Email" }, value: "${inputs.email}" },
    { id: "password", action: "fill", target: { css: "#password" }, value: "${secrets.pw}" },
  ],
};

/** The first revision: another name, no input yet, a literal email, and a step since removed. */
const PAST: Flow = {
  ...FLOW,
  name: "Login",
  inputs: {},
  steps: [
    FLOW.steps[0] as Flow["steps"][number],
    { id: "email", action: "fill", target: { label: "Email" }, value: "ada@example.com" },
    { id: "legacy", action: "click", target: { text: "Sign in" } },
  ],
};

const MANIFEST: FlowManifest = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  revision: REVISION,
  status: "recorded",
  createdAt: EARLIER,
  updatedAt: NOW,
  revisions: [
    { revision: FIRST, savedAt: EARLIER },
    { revision: REVISION, savedAt: NOW },
  ],
};

function editor() {
  const fake = fakeApi({
    "flow.get": () => ({ flow: FLOW, manifest: MANIFEST, revision: REVISION }),
    "flow.save": ({ flow }) => ({ flowId: flow.id, revision: SAVED }),
    "flow.getRevision": ({ revision }) => ({ flow: PAST, revision }),
    "flow.duplicate": ({ newId }) => ({ flowId: newId, revision: "c".repeat(64) }),
  });
  const onDuplicated = vi.fn<(flowId: string) => void>();
  renderWith(fake.api, <Editor flowId="login" onRun={vi.fn()} onDuplicated={onDuplicated} />);
  return { ...fake, onDuplicated };
}

const revisions = () => page.getByRole("list", { name: "Revisions" }).getByRole("listitem");
const table = () => page.getByRole("table", { name: "Revisions compared" });
const row = (name: RegExp) => table().getByRole("row", { name });

test("lists the revisions and compares a past one with the flow as edited", async () => {
  const fake = editor();
  await expect.poll(() => revisions().all().length).toBe(2);
  await expectTexts(revisions().nth(0), "aaaaaaaaaaaa", "current", "2026-11-02 10:00:00");
  await expectTexts(revisions().nth(1), "111111111111", "2026-11-01 09:00:00");
  expect(revisions().nth(0).getByRole("button").query()).toBeNull();
  await page.getByRole("button", { name: "Compare with 111111111111" }).click();
  await expectTexts(table(), "111111111111");
  expect(fake.paramsOf("flow.getRevision")).toEqual([{ flowId: "login", revision: FIRST }]);
  await expectTexts(row(/^field name /), "changed");
  await expectTexts(row(/^field inputs /), "changed");
  await expectTexts(row(/^field actors /), "same");
  await expectTexts(row(/^step open /), "same");
  await expectTexts(row(/^step email /), "changed");
  await expectTexts(row(/^step password /), "added");
  await expectTexts(row(/^step legacy /), "removed");
  // The comparison follows the edits: deleting a step turns it into a removal too.
  await page.getByRole("button", { name: "Delete step open" }).click();
  await expectTexts(row(/^step open /), "removed");
});

test("adds the saved revision to the list as the current one", async () => {
  editor();
  await page.getByRole("button", { name: "Delete step password" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => revisions().all().length).toBe(3);
  await expectTexts(revisions().nth(0), "bbbbbbbbbbbb", "current");
  expect(revisions().nth(1).getByText("current").query()).toBeNull();
  await expect
    .element(page.getByRole("button", { name: "Compare with aaaaaaaaaaaa" }))
    .toBeVisible();
});

test("duplicates the saved flow under a new id and opens the copy", async () => {
  const fake = editor();
  const form = page.getByRole("form", { name: "Duplicate flow" });
  const duplicate = form.getByRole("button", { name: "Duplicate" });
  await expect.element(duplicate).toBeDisabled();
  await form.getByRole("textbox", { name: "New id" }).fill("login copy");
  await expect.element(duplicate).toBeDisabled();
  await form.getByRole("textbox", { name: "New id" }).fill("login-copy");
  await form.getByRole("textbox", { name: "New name" }).fill("Log in (copy)");
  await duplicate.click();
  await expect.poll(() => fake.onDuplicated.mock.calls).toEqual([["login-copy"]]);
  expect(fake.paramsOf("flow.duplicate")).toEqual([
    { flowId: "login", newId: "login-copy", name: "Log in (copy)" },
  ]);
  fake.handlers["flow.duplicate"] = () => {
    throw new ApiError("conflict", "A flow login-copy exists already.");
  };
  await duplicate.click();
  await expectTexts(form.getByRole("alert"), "A flow login-copy exists already.", "conflict");
});

test("compares flows field by field and step by step", () => {
  const same = compareFlows(FLOW, FLOW);
  expect(same.fields.every(({ change }) => change === "same")).toBe(true);
  expect(same.steps.map(({ id, change }) => `${id} ${change}`)).toEqual([
    "open same",
    "email same",
    "password same",
  ]);
  const diff = compareFlows(PAST, FLOW);
  expect(diff.fields).toEqual([
    { name: "name", change: "changed" },
    { name: "description", change: "same" },
    { name: "actors", change: "same" },
    { name: "inputs", change: "changed" },
    { name: "requirements", change: "same" },
    { name: "preconditions", change: "same" },
  ]);
  expect(diff.steps).toEqual([
    { id: "open", change: "same" },
    { id: "email", change: "changed" },
    { id: "password", change: "added" },
    { id: "legacy", change: "removed" },
  ]);
  // Key order never counts as a change.
  const reordered = { ...FLOW, inputs: { email: { required: true, type: "string" } } } as Flow;
  expect(compareFlows(FLOW, reordered).fields[3]).toEqual({ name: "inputs", change: "same" });
});

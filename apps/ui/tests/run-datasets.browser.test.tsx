import type { Flow } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { ApiError } from "@/api/error";
import { datasetDraft, datasetInputs } from "@/features/run/inputs";
import { expectTexts } from "./fake-api";
import { FLOW, SECRET, field, runScreen } from "./run-fixtures";

type Entry = { name: string; inputs: Record<string, unknown>; problem?: string };
const PROBLEM = 'Input "nope" is not declared in the flow.';
const picker = () => page.getByRole("combobox", { name: "Dataset" });
const saveButton = () => page.getByRole("button", { name: "Save dataset" });

test("fills the form from a stored dataset and saves the typed inputs as one, never the secret", async () => {
  const datasets: Entry[] = [
    { name: "ana", inputs: { email: "ana@example.com", retries: 5, remember: true } },
    { name: "stale", inputs: {}, problem: PROBLEM },
  ];
  const fake = runScreen(FLOW, {
    "dataset.list": () => ({ datasets: [...datasets] }),
    "dataset.save": ({ name, inputs }) => {
      datasets.push({ name, inputs });
      return { name };
    },
  });
  await expectTexts(page.getByRole("form", { name: "Inputs" }), `stale: ${PROBLEM}`);
  await expect.element(page.getByRole("option", { name: "stale (cannot be used)" })).toBeDisabled();
  await picker().selectOptions("ana");
  await expect.element(field("email (required)")).toHaveValue("ana@example.com");
  await expect.element(field("retries")).toHaveValue("5");
  await expect.element(page.getByRole("checkbox", { name: "remember" })).toBeChecked();
  await expect.element(saveButton()).toBeDisabled();
  await page.getByLabelText("password (required)").fill(SECRET);
  await field("retries").fill("7");
  await field("Save as dataset").fill("bia");
  await saveButton().click();
  await expect
    .poll(() => fake.paramsOf("dataset.save"))
    .toEqual([
      {
        flowId: "login",
        name: "bia",
        inputs: { email: "ana@example.com", retries: 7, remember: true },
      },
    ]);
  expect(JSON.stringify(fake.calls)).not.toContain(SECRET);
  await expect.element(picker()).toHaveValue("bia");
  await expect.element(field("Save as dataset")).toHaveValue("");
});

test("shows why a dataset cannot be saved, from the form and from the service", async () => {
  const fake = runScreen(FLOW, {
    "dataset.save": () => {
      throw new ApiError("invalid-request", 'Input "email" must be a string.');
    },
  });
  await field("Save as dataset").fill("bia");
  await saveButton().click();
  await expectTexts(page.getByRole("alert"), "email is required.", "invalid-input");
  expect(fake.paramsOf("dataset.save")).toEqual([]);
  await field("email (required)").fill("ana@example.com");
  await saveButton().click();
  await expectTexts(page.getByRole("alert"), 'Input "email" must be a string.', "invalid-request");
});

test("a dataset fills the non-secret fields and leaves the secret as typed", () => {
  const inputs = {
    note: { type: "string", required: false, default: "hi" },
    count: { type: "number", required: false },
    on: { type: "boolean", required: false },
    list: { type: "array", required: false },
    token: { type: "string", required: true, secret: true },
  } as Flow["inputs"];
  const typed = { note: "old", count: "1", on: false, list: "", token: SECRET };
  const values = { count: 3, on: true, list: ["a"] };
  expect(datasetDraft(inputs, values, typed)).toEqual({
    note: "hi",
    count: "3",
    on: true,
    list: '["a"]',
    token: SECRET,
  });
  expect(
    datasetInputs(inputs, { note: "x", count: "", on: true, list: "", token: SECRET }),
  ).toEqual({ ok: true, inputs: { note: "x", on: true }, secrets: {} });
  expect(datasetInputs(inputs, { count: "many", token: "" })).toEqual({
    ok: false,
    message: "count must be a number.",
  });
});

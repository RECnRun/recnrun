import type { Flow, FlowManifest, RunSummary } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { ApiError } from "@/api/error";
import { initialDraft, parseDraft } from "@/features/run/inputs";
import { Run } from "@/features/run/Run";
import { NOW, REVISION, expectTexts, fakeApi, renderWith } from "./fake-api";

const SECRET = "hunter2-do-not-show";

const FLOW = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  actors: {},
  inputs: {
    email: { type: "string", required: true },
    password: { type: "string", required: true, secret: true },
    retries: { type: "number", required: false, default: 2 },
    remember: { type: "boolean", required: false },
    tags: { type: "array", required: false },
  },
  requirements: [],
  preconditions: [],
  steps: [{ id: "open", action: "navigate", url: "http://localhost:4600/login" }],
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

const COUNTS = { total: 2, pending: 0, running: 0, passed: 1, failed: 1, blocked: 0 };
const SUMMARY: RunSummary = {
  schemaVersion: 1,
  runId: "run-1",
  flowId: "login",
  status: "failed",
  exitCode: 1,
  startedAt: NOW,
  endedAt: NOW,
  counts: { ...COUNTS, cancelled: 0, indeterminate: 0 },
  failures: [{ stepId: "email", message: "No element matched the label Email." }],
};

function runScreen(flow: Flow = FLOW) {
  const fake = fakeApi({
    "flow.get": () => ({ flow, manifest: MANIFEST }),
    "flow.replay": () => ({ runId: "run-1" }),
    "run.summary": () => SUMMARY,
  });
  renderWith(fake.api, <Run flowId="login" />);
  return fake;
}

const field = (name: string) => page.getByRole("textbox", { name });
const start = () => page.getByRole("button", { name: "Start run" }).click();

test("starts a run with the inputs and never shows the secret again", async () => {
  const fake = runScreen();
  await field("email (required)").fill("ana@example.com");
  await page.getByLabelText("password (required)").fill(SECRET);
  await page.getByRole("checkbox", { name: "remember" }).click();
  await field("tags").fill('["smoke"]');
  await start();
  await expect
    .poll(() => fake.paramsOf("flow.replay"))
    .toEqual([
      {
        flowId: "login",
        inputs: {
          email: "ana@example.com",
          password: SECRET,
          retries: 2,
          remember: true,
          tags: ["smoke"],
        },
      },
    ]);
  await expect.element(page.getByLabelText("password (required)")).toHaveValue("");
  expect(document.body.innerHTML).not.toContain(SECRET);
  await expect.element(page.getByRole("button", { name: "Stop" })).toBeDisabled();
});

test("shows live step results of its own run, then the summary", async () => {
  const fake = runScreen({ ...FLOW, inputs: {} });
  await expect.element(page.getByText("This flow declares no inputs.")).toBeVisible();
  await start();
  await expect.element(page.getByText("No step has run yet.")).toBeVisible();
  fake.emit("run.step", { runId: "other", result: { stepId: "ghost", status: "passed" } });
  fake.emit("run.step", { runId: "run-1", result: { stepId: "open", status: "running" } });
  fake.emit("run.step", {
    runId: "run-1",
    result: { stepId: "open", status: "passed", attempts: 1 },
  });
  const error = { code: "locator-not-found", message: "No element matched the label Email." };
  fake.emit("run.step", {
    runId: "run-1",
    result: { stepId: "email", status: "failed", attempts: 2, error },
  });
  const rows = page.getByRole("list", { name: "Step results" }).getByRole("listitem");
  await expect.poll(() => rows.all().length).toBe(2);
  await expectTexts(rows.nth(0), "open", "passed", "1 attempt");
  await expectTexts(rows.nth(1), "email", "failed", "2 attempts", error.message, error.code);
  expect(fake.paramsOf("run.summary")).toEqual([]);
  fake.emit("run.finished", { runId: "run-1" });
  const summary = page.getByRole("region", { name: "Run summary" });
  await expectTexts(summary, "failed", "Exit code 1", "passed1", "failed1", "email", error.message);
  expect(fake.paramsOf("run.summary")).toEqual([{ runId: "run-1" }]);
});

test("rejects inputs that do not parse before calling the service", async () => {
  const fake = runScreen();
  await start();
  await expectTexts(page.getByRole("alert"), "email is required.", "invalid-input");
  await field("email (required)").fill("ana@example.com");
  await page.getByLabelText("password (required)").fill(SECRET);
  await field("retries").fill("many");
  await start();
  await expectTexts(page.getByRole("alert"), "retries must be a number.");
  await field("retries").fill("3");
  await field("tags").fill("[oops");
  await start();
  await expectTexts(page.getByRole("alert"), "tags must be JSON (array).");
  expect(fake.paramsOf("flow.replay")).toEqual([]);
});

test("fills defaults but never a secret's", () => {
  const inputs = {
    note: { type: "string", required: false, default: "hi" },
    list: { type: "array", required: false, default: [1] },
    token: { type: "string", required: false, secret: true, default: "x" },
  } as Flow["inputs"];
  expect(initialDraft(inputs)).toEqual({ note: "hi", list: "[1]", token: "" });
  expect(parseDraft(inputs, { note: "", list: "", token: "" })).toEqual({ ok: true, inputs: {} });
});

test("shows the service's errors", async () => {
  const fake = runScreen({ ...FLOW, inputs: {} });
  fake.handlers["flow.replay"] = () => {
    throw new ApiError("chrome-unavailable", "Chrome is not reachable.");
  };
  await start();
  await expectTexts(page.getByRole("alert"), "Chrome is not reachable.", "chrome-unavailable");
  fake.handlers["flow.get"] = () => {
    throw new ApiError("flow-not-found", "No flow login.");
  };
  renderWith(fake.api, <Run flowId="login" />);
  await expectTexts(page.getByRole("alert"), "No flow login.", "flow-not-found");
});

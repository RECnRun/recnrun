import type { Event, Flow, FlowManifest, RunSummary } from "@recnrun/protocol";
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

const going = () => {
  throw new ApiError("conflict", "Run run-1 is still running.");
};

function runScreen(flow: Flow = FLOW) {
  sessionStorage.clear();
  const fake = fakeApi({
    "flow.get": () => ({ flow, manifest: MANIFEST, revision: REVISION }),
    "flow.replay": () => ({ runId: "run-1" }),
    "run.summary": going,
  });
  renderWith(fake.api, <Run flowId="login" />);
  return fake;
}

const field = (name: string) => page.getByRole("textbox", { name });
const start = () => page.getByRole("button", { name: "Start run" }).click();

test("starts a run with the inputs, sends the secret only through secrets, and clears it", async () => {
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
        inputs: { email: "ana@example.com", retries: 2, remember: true, tags: ["smoke"] },
        secrets: { password: SECRET },
      },
    ]);
  await expect.element(page.getByLabelText("password (required)")).toHaveValue("");
  expect(document.body.innerHTML).not.toContain(SECRET);
  await expect.element(page.getByRole("button", { name: "Stop" })).toBeDisabled();
});

test("asks for the flow's recorded secret references and sends them only through secrets", async () => {
  const steps = [
    { id: "key", action: "fill", target: { testId: "key" }, value: "${secrets.apiKey}" },
    {
      id: "pin",
      action: "type",
      target: { testId: "pin" },
      value: "${secrets.apiKey}-${secrets.pin}",
    },
  ];
  const fake = runScreen({ ...FLOW, inputs: {}, steps } as Flow);
  await start();
  await expectTexts(page.getByRole("alert"), "secrets.apiKey is required.");
  await page.getByLabelText("secrets.apiKey (required)").fill(SECRET);
  await page.getByLabelText("secrets.pin (required)").fill("4321");
  await start();
  await expect
    .poll(() => fake.paramsOf("flow.replay"))
    .toEqual([{ flowId: "login", inputs: {}, secrets: { apiKey: SECRET, pin: "4321" } }]);
  await expect.element(page.getByLabelText("secrets.apiKey (required)")).toHaveValue("");
  expect(document.body.innerHTML).not.toContain(SECRET);
});

let seq = 0;

/** A replay journal event of `stepId`, as the service pushes it in `run.step`. */
function stepEvent(runId: string, stepId: string, type: string, payload: Record<string, unknown>) {
  seq += 1;
  const event = {
    schemaVersion: 1,
    id: `engine:replay#${seq}`,
    runId,
    seq,
    source: "engine",
    producer: "engine:replay",
    timestamp: NOW,
    targetId: null,
    frameId: null,
    documentId: null,
    stepId,
    category: "step",
    type,
    payload,
  } as Event;
  return { type: "run.step" as const, runId, event };
}

test("shows live step results of its own run, then the pushed summary", async () => {
  const fake = runScreen({ ...FLOW, inputs: {} });
  await expect.element(page.getByText("This flow declares no inputs.")).toBeVisible();
  await start();
  await expect.element(page.getByText("No step has run yet.")).toBeVisible();
  fake.emit("run.step", stepEvent("other", "ghost", "step.finished", { status: "passed" }));
  fake.emit("run.step", stepEvent("run-1", "open", "step.started", { index: 0 }));
  fake.emit(
    "run.step",
    stepEvent("run-1", "open", "step.finished", { index: 0, status: "passed", attempts: 1 }),
  );
  const error = { code: "locator-not-found", message: "No element matched the label Email." };
  fake.emit("run.step", stepEvent("run-1", "email", "step.started", { index: 1 }));
  const rows = page.getByRole("list", { name: "Step results" }).getByRole("listitem");
  await expect.poll(() => rows.all().length).toBe(2);
  await expectTexts(rows.nth(1), "email", "running");
  fake.emit(
    "run.step",
    stepEvent("run-1", "email", "step.finished", {
      index: 1,
      status: "failed",
      attempts: 2,
      error,
    }),
  );
  fake.emit("run.step", stepEvent("run-1", "email", "step.note", { index: 1 }));
  await expectTexts(rows.nth(0), "open", "passed", "1 attempt");
  await expectTexts(rows.nth(1), "email", "failed", "2 attempts", error.message, error.code);
  expect(page.getByRole("region", { name: "Run summary" }).query()).toBeNull();
  fake.emit("run.finished", {
    type: "run.finished",
    runId: "other",
    summary: { ...SUMMARY, runId: "other" },
  });
  fake.emit("run.finished", { type: "run.finished", runId: "run-1", summary: SUMMARY });
  const summary = page.getByRole("region", { name: "Run summary" });
  await expectTexts(summary, "failed", "Exit code 1", "passed1", "failed1", "email", error.message);
  await expect.element(page.getByRole("button", { name: "Start run" })).toBeEnabled();
  expect(fake.paramsOf("run.summary")[0]).toEqual({ runId: "run-1" });
});

const startButton = () => page.getByRole("button", { name: "Start run" });

test("recovers the summary through run.summary when the push never arrives", async () => {
  const fake = runScreen({ ...FLOW, inputs: {} });
  let asked = 0;
  fake.handlers["run.summary"] = () => {
    asked += 1;
    return asked < 2 ? going() : SUMMARY;
  };
  await start();
  await expect.element(startButton()).toBeDisabled();
  const summary = page.getByRole("region", { name: "Run summary" });
  await expectTexts(summary, "failed", "Exit code 1");
  await expect.element(startButton()).toBeEnabled();
});

test("asks for the summary again as soon as the event socket reconnects", async () => {
  const fake = runScreen({ ...FLOW, inputs: {} });
  await start();
  await expect.poll(() => fake.paramsOf("run.summary").length).toBe(2);
  fake.handlers["run.summary"] = () => SUMMARY;
  fake.reconnect();
  // The next poll is a second away, so only the reconnect can ask this soon.
  await expect.poll(() => fake.paramsOf("run.summary").length, { timeout: 400 }).toBe(3);
  await expectTexts(page.getByRole("region", { name: "Run summary" }), "Exit code 1");
});

test("surfaces a replay that failed before it could write a summary", async () => {
  const fake = runScreen({ ...FLOW, inputs: {} });
  fake.handlers["run.summary"] = () => {
    throw new ApiError("internal", "Chrome closed the CDP connection.");
  };
  await start();
  await expectTexts(page.getByRole("alert"), "Chrome closed the CDP connection.", "internal");
  await expect.element(startButton()).toBeEnabled();
});

test("returning to the Run screen restores the run it started", async () => {
  const fake = runScreen({ ...FLOW, inputs: {} });
  await start();
  await expect.poll(() => fake.paramsOf("run.summary").length).toBeGreaterThan(0);
  renderWith(fake.api, <p>Elsewhere</p>);
  fake.handlers["run.summary"] = () => SUMMARY;
  renderWith(fake.api, <Run flowId="login" />);
  await expectTexts(page.getByRole("region", { name: "Run summary" }), "failed", "Exit code 1");
  expect(fake.paramsOf("flow.replay")).toHaveLength(1);
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
  expect(parseDraft(inputs, { note: "", list: "", token: "" })).toEqual({
    ok: true,
    inputs: {},
    secrets: {},
  });
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

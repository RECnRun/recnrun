import type { RunComparison } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { ApiError } from "@/api/error";
import { Compare } from "@/features/diagnostics/Compare";
import { comparisonView } from "@/features/diagnostics/comparison";
import { recentRuns, rememberRun } from "@/features/diagnostics/recent";
import { NOW, expectTexts, fakeApi, renderWith } from "./fake-api";

const SAVE = "http://127.0.0.1:4600/api/json";

const steps = (run: string): RunComparison["steps"] => [
  { stepId: "open", index: 0, baseline: "passed", run: "passed" },
  { stepId: "fetch", index: 1, baseline: "passed", run: "passed" },
  { stepId: "result", index: 2, baseline: "passed", run: run as never },
];

const base = {
  schemaVersion: 1 as const,
  baselineRunId: "run-base",
  runId: "run-1",
  flowId: "fetch-json",
};

const SERVER_ERROR: RunComparison = {
  ...base,
  sameRevision: false,
  steps: steps("failed"),
  divergence: {
    kind: "application",
    reason: "network-status",
    stepId: "fetch",
    index: 1,
    message: `${SAVE} answered 500 in this run and 200 in the baseline.`,
    baseline: { url: SAVE, httpStatus: 200, eventId: "cdp:network#1" },
    run: { url: SAVE, httpStatus: 500, eventId: "cdp:network#1" },
  },
};

const LOST: RunComparison = {
  ...base,
  sameRevision: true,
  steps: steps("passed"),
  divergence: {
    kind: "collector-gap",
    reason: "collector-gap",
    stepId: "fetch",
    index: 1,
    message: "This run lost events (buffer-exhausted); what it did not record is unknown.",
    baseline: {},
    run: {
      eventId: "cdp:network#9",
      gap: { reason: "buffer-exhausted", surface: "network", lost: 2 },
    },
  },
};

describe("the comparison's view model", () => {
  test("names a different response status as an application failure at its step", () => {
    const view = comparisonView(SERVER_ERROR);
    expect(view).toMatchObject({
      verdict: "Application failure",
      tone: "danger",
      headline: "First divergence at step fetch (step 2 of 3): response status",
      sides: [`Baseline: 200 ${SAVE}`, `This run: 500 ${SAVE}`],
    });
    expect(view.notes).toContain("The runs replay different revisions of the flow.");
    expect(view.rows.map(({ first }) => first)).toEqual([false, true, false]);
  });

  test("reports lost events as a collector gap and never blames the application", () => {
    const view = comparisonView(LOST);
    expect(view.verdict).toBe("Collector gap");
    expect(view.tone).toBe("neutral");
    expect(view.sides).toEqual([
      "This run: lost events: buffer-exhausted on network, 2 events lost",
    ]);
    expect(JSON.stringify(view)).not.toContain("Application failure");
    expect(view.notes).toContain(
      "Not an application failure: the collector lost events, so what happened then is unknown.",
    );
  });

  test("names a replay problem and a step that ended differently", () => {
    const view = comparisonView({
      ...SERVER_ERROR,
      divergence: {
        kind: "replay",
        reason: "step-status",
        stepId: "result",
        index: 2,
        message: "Step result is cancelled in this run and passed in the baseline.",
        baseline: { status: "passed" },
        run: { status: "cancelled", error: { code: "cancelled", message: "The run was stopped." } },
      },
    });
    expect(view).toMatchObject({
      verdict: "Replay problem",
      headline: "First divergence at step result (step 3 of 3): step status",
      sides: ["Baseline: passed", "This run: cancelled, The run was stopped. (cancelled)"],
    });
  });

  test("says when nothing observable differs", () => {
    const view = comparisonView({ ...LOST, divergence: null });
    expect(view).toMatchObject({ verdict: "No observable divergence", headline: undefined });
  });
});

describe("recent runs", () => {
  test("remembers the runs this tab opened, newest first, once each", () => {
    sessionStorage.clear();
    rememberRun({ runId: "run-a", flowId: "f", status: "passed", startedAt: NOW });
    rememberRun({ runId: "run-b", flowId: "f", status: "failed", startedAt: NOW });
    rememberRun({ runId: "run-a", flowId: "f", status: "passed", startedAt: NOW });
    expect(recentRuns().map(({ runId }) => runId)).toEqual(["run-a", "run-b"]);
    sessionStorage.setItem("recnrun.diagnostics.runs", "{not json");
    expect(recentRuns()).toEqual([]);
  });
});

function renderCompare(answer: (baselineRunId: string) => RunComparison) {
  sessionStorage.clear();
  rememberRun({ runId: "run-base", flowId: "fetch-json", status: "passed", startedAt: NOW });
  rememberRun({ runId: "run-other", flowId: "another-flow", status: "passed", startedAt: NOW });
  const fake = fakeApi({ "run.compare": ({ baselineRunId }) => answer(baselineRunId) });
  renderWith(fake.api, <Compare runId="run-1" flowId="fetch-json" />);
  return fake;
}

describe("the compare card", () => {
  test("compares with a baseline of the same flow and points at the first divergence", async () => {
    const fake = renderCompare(() => SERVER_ERROR);
    const options = [...document.querySelectorAll("datalist option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(["run-base"]);
    await page.getByRole("combobox", { name: "Baseline run" }).fill("run-base");
    await page.getByRole("button", { name: "Compare" }).click();
    const result = page.getByRole("region", { name: "Comparison" });
    await expectTexts(
      result,
      "Application failure",
      "First divergence at step fetch",
      `This run: 500 ${SAVE}`,
    );
    await expect
      .element(page.getByRole("row", { name: /fetch/ }))
      .toHaveAttribute("aria-current", "step");
    expect(fake.paramsOf("run.compare")).toEqual([{ baselineRunId: "run-base", runId: "run-1" }]);
  });

  test("shows a collector gap as a collector gap", async () => {
    renderCompare(() => LOST);
    await page.getByRole("combobox", { name: "Baseline run" }).fill("run-base");
    await page.getByRole("button", { name: "Compare" }).click();
    const result = page.getByRole("region", { name: "Comparison" });
    await expectTexts(result, "Collector gap", "Not an application failure");
    expect(result.query()?.textContent).not.toContain("Application failure");
  });

  test("shows the service's refusal", async () => {
    renderCompare(() => {
      throw new ApiError("invalid-request", "Run run-1 replays fetch-json, not another-flow.");
    });
    await page.getByRole("combobox", { name: "Baseline run" }).fill("run-other");
    await page.getByRole("button", { name: "Compare" }).click();
    await expectTexts(
      page.getByRole("alert"),
      "replays fetch-json, not another-flow",
      "invalid-request",
    );
  });
});

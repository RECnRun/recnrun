import type { Flow, RunSummary } from "@recnrun/protocol";
import { render } from "preact";
import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { App } from "@/app/App";
import { hrefOf, parseHash } from "@/app/routes";
import { Diagnostics } from "@/features/diagnostics/Diagnostics";
import { NO_FILTERS, queryOf, shownBy } from "@/features/diagnostics/filters";
import { causeLabel, timelineRow } from "@/features/diagnostics/rows";
import { NOW, REVISION, expectTexts, fakeApi, renderWith } from "./fake-api";
import { lostNetwork, runEvent } from "./run-events";

const SUMMARY: RunSummary = {
  schemaVersion: 1,
  runId: "run-1",
  flowId: "save-form",
  status: "failed",
  exitCode: 1,
  startedAt: NOW,
  endedAt: NOW,
  counts: {
    total: 2,
    pending: 0,
    running: 0,
    passed: 1,
    failed: 1,
    blocked: 0,
    cancelled: 0,
    indeterminate: 0,
  },
  failures: [{ stepId: "status", message: 'status: expected "Saved"' }],
};

const started = (stepId: string) =>
  runEvent("step", "step.started", { index: 0 }, { stepId, source: "engine" });
const response = runEvent(
  "network",
  "response",
  { requestId: "r-1", url: "http://127.0.0.1:4600/api/json", status: 500, statusText: "" },
  { stepId: "submit", causalConfidence: "temporal-only", profileBinding: "work" },
);
const gap = lostNetwork(2, { stepId: "submit" });

describe("the timeline's view model", () => {
  test("queries the service with every filter and lets gaps-only override the category", () => {
    expect(queryOf("run-1", NO_FILTERS)).toEqual({ runId: "run-1", limit: 100 });
    const filters = {
      profile: " work ",
      stepId: "submit",
      origin: "http://127.0.0.1:4600",
      category: "network",
      coverage: "all",
    } as const;
    expect(queryOf("run-1", filters, "7")).toEqual({
      runId: "run-1",
      limit: 100,
      profile: "work",
      stepId: "submit",
      origin: "http://127.0.0.1:4600",
      category: "network",
      cursor: "7",
    });
    expect(queryOf("run-1", { ...filters, coverage: "gaps" }).category).toBe("gap");
  });

  test("keeps gaps out of the observed coverage only", () => {
    expect(shownBy(NO_FILTERS)(gap)).toBe(true);
    expect(shownBy({ ...NO_FILTERS, coverage: "observed" })(gap)).toBe(false);
    expect(shownBy({ ...NO_FILTERS, coverage: "observed" })(response)).toBe(true);
  });

  test("labels a gap as a collector gap and an event by how it is tied to its command", () => {
    expect(timelineRow(gap)).toMatchObject({
      gap: true,
      summary: "collector gap: buffer-exhausted on network, 2 events lost",
    });
    expect(timelineRow(response)).toMatchObject({
      gap: false,
      category: "network",
      stepId: "submit",
      profile: "work",
      summary: "500 http://127.0.0.1:4600/api/json",
      cause: "temporal only",
    });
    expect(causeLabel("command-id")).toBe("linked by command id");
    expect(causeLabel(undefined)).toBeUndefined();
  });
});

describe("the route", () => {
  test("parses and writes the diagnostics of a run", () => {
    expect(parseHash("#/runs/run-1")).toEqual({ screen: "diagnostics", runId: "run-1" });
    expect(hrefOf({ screen: "diagnostics", runId: "a b" })).toBe("#/runs/a%20b");
  });
});

const FLOW = {
  schemaVersion: 1,
  id: "save-form",
  name: "Save the form",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [{ id: "open", action: "navigate", url: "http://127.0.0.1:4600/routes/form" }],
} as Flow;

test("opens a finished run's diagnostics from the run screen and goes back", async () => {
  sessionStorage.setItem("recnrun.run.save-form", "run-1");
  const fake = fakeApi({
    "flow.get": () => ({ flow: FLOW, manifest: {} as never, revision: REVISION }),
    "run.summary": () => SUMMARY,
    "run.queryEvents": () => ({ events: [] }),
  });
  location.hash = "#/flows/save-form/run";
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<App api={fake.api} />, root);
  await page.getByRole("button", { name: "Diagnostics" }).click();
  expect(location.hash).toBe("#/runs/run-1");
  await expect.element(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await page.getByRole("button", { name: "Back to run" }).click();
  expect(location.hash).toBe("#/flows/save-form/run");
  sessionStorage.clear();
});

function diagnostics(pages: Record<string, { events: unknown[]; nextCursor?: string }>) {
  const fake = fakeApi({
    "run.summary": () => SUMMARY,
    "run.queryEvents": (params) => {
      if (params.types) return { events: [started("open"), started("submit")] };
      return (pages[params.cursor ?? "first"] ?? { events: [] }) as never;
    },
  });
  renderWith(fake.api, <Diagnostics runId="run-1" onBack={() => undefined} />);
  return fake;
}

describe("the diagnostics screen", () => {
  test("shows the run and pages its timeline with the service's cursor", async () => {
    const fake = diagnostics({
      first: { events: [started("open"), response], nextCursor: "2" },
      "2": { events: [gap] },
    });
    const timeline = page.getByRole("list", { name: "Timeline" });
    await expectTexts(page.getByRole("region", { name: "Run run-1" }), "failed", "save-form");
    await expectTexts(timeline, "step.started", "500 http://127.0.0.1:4600/api/json");
    await expectTexts(timeline, "temporal only");
    await page.getByRole("button", { name: "Load more" }).click();
    await expectTexts(timeline, "collector gap: buffer-exhausted on network, 2 events lost");
    await expect.element(page.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(timeline.query()?.textContent).not.toContain("application failure");
    expect(fake.paramsOf("run.queryEvents").filter((p) => !("types" in (p as object)))).toEqual([
      { runId: "run-1", limit: 100 },
      { runId: "run-1", limit: 100, cursor: "2" },
    ]);
  });

  test("queries again from the start when a filter changes", async () => {
    const fake = diagnostics({ first: { events: [response, gap] } });
    await expectTexts(page.getByRole("list", { name: "Timeline" }), "collector gap");
    await page.getByRole("combobox", { name: "Step" }).selectOptions("submit");
    await page.getByRole("combobox", { name: "Category" }).selectOptions("network");
    await page.getByRole("textbox", { name: "Profile" }).fill("work");
    await page.getByRole("textbox", { name: "Origin" }).fill("http://127.0.0.1:4600");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect
      .poll(() => fake.paramsOf("run.queryEvents").at(-1))
      .toEqual({
        runId: "run-1",
        limit: 100,
        stepId: "submit",
        category: "network",
        profile: "work",
        origin: "http://127.0.0.1:4600",
      });
    await page.getByRole("combobox", { name: "Coverage" }).selectOptions("observed");
    await page.getByRole("button", { name: "Apply filters" }).click();
    const timeline = page.getByRole("list", { name: "Timeline" });
    await expect.poll(() => timeline.query()?.textContent ?? "").not.toContain("collector gap");
    await expectTexts(timeline, "500 http://127.0.0.1:4600/api/json");
  });

  test("says when no event matches", async () => {
    diagnostics({ first: { events: [] } });
    await expectTexts(page.getByRole("region", { name: "Timeline" }), "No event matches");
  });
});

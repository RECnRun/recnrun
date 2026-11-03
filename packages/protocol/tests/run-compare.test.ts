import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { RunComparisonSchema, RunDivergenceSchema, SERVICE_COMMANDS } from "../src/index.ts";

const divergence = {
  kind: "application",
  reason: "network-status",
  stepId: "submit",
  index: 2,
  message: "POST /api/save answered 500 instead of 200.",
  baseline: { url: "http://127.0.0.1:4600/api/save", httpStatus: 200 },
  run: { url: "http://127.0.0.1:4600/api/save", httpStatus: 500, eventId: "cdp:network#4" },
};

describe("RunDivergenceSchema", () => {
  test("accepts an application divergence", () => {
    expect(v.parse(RunDivergenceSchema, divergence)).toEqual(divergence);
  });

  test("keeps a collector gap apart from the application", () => {
    const gap = {
      ...divergence,
      kind: "collector-gap",
      reason: "collector-gap",
      run: { gap: { reason: "buffer-exhausted", lost: 3 } },
    };
    expect(v.safeParse(RunDivergenceSchema, gap).success).toBe(true);
    for (const value of [
      { ...gap, kind: "application" },
      { ...gap, kind: "replay" },
      { ...divergence, kind: "collector-gap" },
    ])
      expect(v.safeParse(RunDivergenceSchema, value).success).toBe(false);
  });
});

describe("run.compare", () => {
  const { params, result } = SERVICE_COMMANDS["run.compare"];

  test("takes a baseline run and a run", () => {
    expect(v.safeParse(params, { baselineRunId: "run-1", runId: "run-2" }).success).toBe(true);
    expect(v.safeParse(params, { runId: "run-2" }).success).toBe(false);
    expect(v.safeParse(params, { baselineRunId: "run-1", runId: "" }).success).toBe(false);
  });

  test("answers the aligned steps and the first divergence, or none", () => {
    const comparison = {
      schemaVersion: 1,
      baselineRunId: "run-1",
      runId: "run-2",
      flowId: "form-submit",
      sameRevision: true,
      steps: [{ stepId: "submit", index: 0, baseline: "passed", run: "failed" }],
      divergence,
    };
    expect(v.safeParse(result, comparison).success).toBe(true);
    expect(v.safeParse(RunComparisonSchema, { ...comparison, divergence: null }).success).toBe(
      true,
    );
    expect(v.safeParse(result, { ...comparison, divergence: undefined }).success).toBe(false);
  });
});

describe("run.queryEvents", () => {
  const { params } = SERVICE_COMMANDS["run.queryEvents"];

  test("filters by types, origin, profile, and a time range", () => {
    const query = {
      runId: "run-1",
      types: ["response", "gap"],
      origin: "http://127.0.0.1:4600",
      profile: "default",
      from: "2026-11-02T10:00:00.000Z",
      to: "2026-11-02T10:01:00.000Z",
    };
    expect(v.safeParse(params, query).success).toBe(true);
    for (const bad of [{ types: [] }, { types: [""] }, { from: "yesterday" }, { origin: "" }])
      expect(v.safeParse(params, { runId: "run-1", ...bad }).success).toBe(false);
  });
});

import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  CAPTURE_SURFACES,
  CapabilityMatrixSchema,
  RUN_EXIT_CODES,
  RunCoverageSchema,
  RunManifestSchema,
  RunStepsSchema,
  RunSummarySchema,
} from "../src/index.ts";

const counts = {
  total: 2,
  pending: 0,
  running: 0,
  passed: 1,
  failed: 1,
  blocked: 0,
  cancelled: 0,
  indeterminate: 0,
};

const summary = {
  schemaVersion: 1,
  runId: "run-1",
  flowId: "pedido-aprovacao",
  status: "failed",
  exitCode: 1,
  startedAt: "2026-11-02T10:00:00.000Z",
  endedAt: "2026-11-02T10:00:05.000Z",
  counts,
  failures: [{ stepId: "status", message: "Expected Aprovado", evidence: ["blobs/sha256/a"] }],
};

describe("RunSummarySchema", () => {
  test("maps passed, failed, error, and interrupted to exit codes 0, 1, 2, 2", () => {
    expect(RUN_EXIT_CODES).toEqual({ passed: 0, failed: 1, error: 2, interrupted: 2 });
  });

  test("accepts a summary whose exit code matches its status", () => {
    expect(v.safeParse(RunSummarySchema, summary).success).toBe(true);
  });

  test("rejects a summary whose exit code contradicts its status", () => {
    expect(v.safeParse(RunSummarySchema, { ...summary, exitCode: 0 }).success).toBe(false);
  });
});

test("RunManifestSchema keeps the flow revision and the effective versions", () => {
  const manifest = {
    schemaVersion: 1,
    runId: "run-1",
    flowId: "pedido-aprovacao",
    flowRevision: "a".repeat(64),
    startedAt: "2026-11-02T10:00:00.000Z",
    captureLevel: "normal",
    versions: { engine: "0.0.0", protocol: 1, chrome: "156.0.8078.76" },
    bindings: { solicitante: "Work profile" },
  };
  expect(v.safeParse(RunManifestSchema, manifest).success).toBe(true);
  expect(v.safeParse(RunManifestSchema, { ...manifest, flowRevision: "HEAD" }).success).toBe(false);
});

test("RunStepsSchema records each executed instance with its path", () => {
  const steps = {
    schemaVersion: 1,
    runId: "run-1",
    steps: [
      {
        stepId: "processar",
        stepPath: ["percorrer", "decidir"],
        iterationId: "i-3",
        status: "passed",
      },
      { stepId: "status", status: "failed", error: { code: "step-failed", message: "x" } },
    ],
  };
  expect(v.safeParse(RunStepsSchema, steps).success).toBe(true);
  expect(
    v.safeParse(RunStepsSchema, { ...steps, steps: [{ stepId: "x", status: "ok" }] }).success,
  ).toBe(false);
});

test("RunCoverageSchema and the capability matrix share statuses and surfaces", () => {
  const coverage = {
    schemaVersion: 1,
    runId: "run-1",
    surfaces: CAPTURE_SURFACES.map((surface) => ({ surface, status: "planned", reasons: [] })),
  };
  expect(v.safeParse(RunCoverageSchema, coverage).success).toBe(true);
  const matrix = {
    schemaVersion: 1,
    capabilities: [
      { kind: "surface", id: "network", status: "partial", phase: "F3", notes: "No bodies yet" },
      { kind: "feature", id: "action.click", status: "planned", phase: "F2" },
    ],
  };
  expect(v.safeParse(CapabilityMatrixSchema, matrix).success).toBe(true);
  const unknownSurface = { kind: "surface", id: "telepathy", status: "planned", phase: "F6" };
  expect(
    v.safeParse(CapabilityMatrixSchema, { ...matrix, capabilities: [unknownSurface] }).success,
  ).toBe(false);
});

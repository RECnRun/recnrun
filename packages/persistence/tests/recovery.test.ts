import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverageOf, type Event } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { openFlowStore, recoverRuns, type FlowStore } from "../src/index.ts";
import { runManifest, runSummary, spikeFlow } from "./flow-fixtures.ts";

const at = new Date("2026-11-02T11:00:00.000Z");

let home = "";
let store: FlowStore;
let revision = "";
const runFolder = (runId: string) => join(home, ".recnrun", "flows", "form-submit", "runs", runId);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-recovery-"));
  store = await openFlowStore({ home });
  ({ revision } = await store.saveFlow(spikeFlow()));
});
afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

const stepEvent = (runId: string, seq: number, stepId: string, type: string): Event => ({
  schemaVersion: 1,
  id: `engine:replay#${seq}`,
  runId,
  seq,
  source: "engine",
  producer: "engine:replay",
  timestamp: `2026-11-02T10:00:0${seq}.000Z`,
  targetId: null,
  frameId: null,
  documentId: null,
  stepId,
  category: "step",
  type,
  payload: type === "step.started" ? { index: 0 } : { index: 0, status: "passed" },
});

/** Starts a run whose journal holds `steps` as [stepId, finished] pairs, then leaves it open. */
async function leaveRunning(runId: string, steps: [string, boolean][]) {
  const run = await store.createRun(runManifest(revision, runId));
  let seq = 0;
  for (const [stepId, finished] of steps) {
    await run.journal.append(stepEvent(runId, ++seq, stepId, "step.started"));
    if (finished) await run.journal.append(stepEvent(runId, ++seq, stepId, "step.finished"));
  }
  await run.journal.close();
}

const statuses = async (runId: string) =>
  (await store.getRun("form-submit", runId)).steps?.steps.map(({ status }) => status);

test("a write step cut short is indeterminate and the journal records the restart", async () => {
  await leaveRunning("run-1", [
    ["open", true],
    ["fill-name", false],
  ]);
  expect(await recoverRuns(store, () => at)).toEqual({
    recovered: [{ flowId: "form-submit", runId: "run-1", indeterminate: 1 }],
    problems: [],
  });
  const run = await store.getRun("form-submit", "run-1");
  expect(await statuses("run-1")).toEqual([
    "passed",
    "indeterminate",
    "cancelled",
    "cancelled",
    "cancelled",
  ]);
  expect(run.steps?.steps[1]).toMatchObject({
    startedAt: "2026-11-02T10:00:03.000Z",
    error: { code: "run-interrupted" },
  });
  expect(run.summary).toMatchObject({
    status: "interrupted",
    exitCode: 2,
    endedAt: "2026-11-02T10:00:03.000Z",
    counts: { total: 5, passed: 1, indeterminate: 1, cancelled: 3 },
    failures: [{ stepId: "fill-name", message: expect.stringContaining("unknown") }],
  });
  expect(run.journal.events.at(-1)).toMatchObject({
    producer: "service:recovery",
    seq: 1,
    timestamp: at.toISOString(),
    category: "gap",
    type: "producer-restarted",
    payload: { reason: "producer-restarted", lastSeq: 3, startedAt: at.toISOString() },
  });
  expect(await store.listRuns()).toEqual([expect.objectContaining({ status: "interrupted" })]);
  expect(await recoverRuns(store, () => at)).toEqual({ recovered: [], problems: [] });
});

test("a read-only step cut short is cancelled and a truncated journal keeps its gap", async () => {
  await leaveRunning("run-1", [
    ["open", true],
    ["fill-name", true],
    ["submit", true],
    ["read-status", false],
  ]);
  await appendFile(join(runFolder("run-1"), "events.jsonl"), '{"schemaVersion":1,"id":');
  await recoverRuns(store, () => at);
  expect(await statuses("run-1")).toEqual(["passed", "passed", "passed", "cancelled", "cancelled"]);
  const { journal, summary } = await store.getRun("form-submit", "run-1");
  expect(journal.gap).toBeUndefined();
  expect(journal.events.slice(-2).map(({ type, seq }) => `${type} ${seq}`)).toEqual([
    "journal-truncated 1",
    "producer-restarted 2",
  ]);
  expect(summary).toMatchObject({ status: "interrupted", failures: [] });
  const { coverage } = await store.getRun("form-submit", "run-1");
  expect(coverage, "coverage.json reconciles with the journal").toEqual(
    coverageOf("run-1", journal.events),
  );
  expect(coverage?.gaps).toEqual([
    { reason: "journal-truncated", gaps: 1, lostEvents: 0 },
    { reason: "producer-restarted", gaps: 1, lostEvents: 0 },
  ]);
});

test("a run it cannot read stays as it is and is reported", async () => {
  await leaveRunning("run-1", []);
  await leaveRunning("run-2", []);
  await store.finishRun({
    summary: runSummary("run-2"),
    steps: { schemaVersion: 1, runId: "run-2", steps: [] },
    coverage: { schemaVersion: 1, runId: "run-2", surfaces: [] },
  });
  await writeFile(join(runFolder("run-1"), "manifest.json"), "{");
  const report = await recoverRuns(store, () => at);
  expect(report).toMatchObject({
    recovered: [],
    problems: [{ flowId: "form-submit", runId: "run-1", message: expect.any(String) }],
  });
  expect((await store.listRuns()).map(({ id, status }) => `${id} ${status}`).toSorted()).toEqual([
    "run-1 running",
    "run-2 passed",
  ]);
});

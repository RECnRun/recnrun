import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@recnrun/protocol";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { openFlowStore, type FlowStore } from "../src/index.ts";
import { filesBelow, runManifest, runSummary, spikeFlow } from "./flow-fixtures.ts";

const event = (seq: number): Event => ({
  schemaVersion: 1,
  id: `cdp:S1#${seq}`,
  runId: "run-1",
  seq,
  source: "S1",
  producer: "cdp:S1",
  timestamp: "2026-11-02T10:00:01.000Z",
  targetId: "T1",
  frameId: "T1",
  documentId: null,
  category: "console",
  type: "api",
  payload: { level: "log", args: [`message ${seq}`] },
});

let home = "";
let store: FlowStore;
let revision = "";
const runsRoot = () => join(home, ".recnrun", "flows", "form-submit", "runs");

const finish = (runId = "run-1") =>
  store.finishRun({
    summary: runSummary(runId),
    steps: { schemaVersion: 1, runId, steps: [{ stepId: "open", status: "passed" }] },
    coverage: { schemaVersion: 1, runId, surfaces: [] },
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "recnrun-runs-"));
  store = await openFlowStore({ home });
  ({ revision } = await store.saveFlow(spikeFlow()));
});
afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

test("a run references its revision and writes the run files of source §12", async () => {
  const run = await store.createRun(runManifest(revision));
  await run.journal.append(event(1));
  await run.journal.close();
  expect(await store.listRuns("form-submit")).toEqual([
    {
      id: "run-1",
      flowId: "form-submit",
      revision,
      status: "running",
      startedAt: "2026-11-02T10:00:00.000Z",
      finishedAt: null,
    },
  ]);
  await finish();
  expect(await filesBelow(join(runsRoot(), "run-1"))).toEqual([
    "coverage.json",
    "events.jsonl",
    "manifest.json",
    "steps.json",
    "summary.json",
  ]);
  const stored = await store.getRun("form-submit", "run-1");
  expect(stored).toMatchObject({
    manifest: { flowRevision: revision },
    summary: { status: "passed" },
    steps: { steps: [{ stepId: "open" }] },
    journal: { events: [event(1)] },
  });
  expect(await store.listRuns()).toEqual([
    expect.objectContaining({ status: "passed", finishedAt: "2026-11-02T10:00:05.000Z" }),
  ]);
});

test("a truncated events.jsonl loads with a gap", async () => {
  const run = await store.createRun(runManifest(revision));
  await run.journal.append(event(1));
  await run.journal.close();
  await appendFile(join(runsRoot(), "run-1", "events.jsonl"), '{"schemaVersion":1,"id":');
  const { journal, summary } = await store.getRun("form-submit", "run-1");
  expect(summary).toBeUndefined();
  expect(journal).toMatchObject({
    events: [event(1)],
    gap: { reason: "journal-truncated", lastSeq: 1 },
  });
});

test("a run needs a stored revision, a slug id, and a new folder", async () => {
  await expect(store.createRun(runManifest("f".repeat(64)))).rejects.toMatchObject({
    code: "not-found",
  });
  await expect(store.createRun(runManifest(revision, "../x"))).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(
    store.createRun({ ...runManifest(revision), flowRevision: "x" }),
  ).rejects.toMatchObject({
    code: "invalid",
  });
  const run = await store.createRun(runManifest(revision));
  await run.journal.close();
  await expect(store.createRun(runManifest(revision))).rejects.toMatchObject({
    code: "run-exists",
  });
});

test("a result for another run is refused", async () => {
  const run = await store.createRun(runManifest(revision));
  await run.journal.close();
  await expect(
    store.finishRun({
      summary: runSummary(),
      steps: { schemaVersion: 1, runId: "run-2", steps: [] },
      coverage: { schemaVersion: 1, runId: "run-1", surfaces: [] },
    }),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(finish("run-2")).rejects.toMatchObject({ code: "not-found" });
});

test("rebuilding lists the same runs and reports a corrupt one", async () => {
  for (const runId of ["run-1", "run-2", "run-3"]) {
    const run = await store.createRun(runManifest(revision, runId));
    await run.journal.close();
  }
  await finish("run-1");
  const before = await store.listRuns();
  store.close();
  await rm(join(home, ".recnrun", "index.sqlite"));
  store = await openFlowStore({ home });
  expect(await store.listRuns()).toEqual(before);
  await writeFile(join(runsRoot(), "run-3", "summary.json"), "[]");
  const { problems } = await store.rebuildIndex();
  expect(problems).toEqual([
    expect.objectContaining({ code: "invalid", path: join(runsRoot(), "run-3", "summary.json") }),
  ]);
  expect((await store.listRuns("form-submit")).map(({ id }) => id)).toEqual(["run-1", "run-2"]);
});

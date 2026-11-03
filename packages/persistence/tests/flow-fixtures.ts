import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Flow, RunManifest, RunSummary } from "@recnrun/protocol";

/** The F1.6 replay spike flow: a valid flow with an actor, an input, and a requirement. */
export const spikeFlow = (): Flow =>
  JSON.parse(
    readFileSync(
      new URL("../../../tests/browser/fixtures/replay-spike.flow.json", import.meta.url),
      "utf8",
    ),
  ) as Flow;

export const runManifest = (flowRevision: string, runId = "run-1"): RunManifest => ({
  schemaVersion: 1,
  runId,
  flowId: "form-submit",
  flowRevision,
  startedAt: "2026-11-02T10:00:00.000Z",
  captureLevel: "normal",
  versions: { engine: "0.0.0", protocol: 1 },
  bindings: { requester: "Ana" },
});

export const runSummary = (runId = "run-1"): RunSummary => ({
  schemaVersion: 1,
  runId,
  flowId: "form-submit",
  status: "passed",
  exitCode: 0,
  startedAt: "2026-11-02T10:00:00.000Z",
  endedAt: "2026-11-02T10:00:05.000Z",
  counts: {
    total: 1,
    pending: 0,
    running: 0,
    passed: 1,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    indeterminate: 0,
  },
  failures: [],
});

/** Every file below `folder`, relative and sorted, so a test sees temporary files left behind. */
export async function filesBelow(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1))
    .toSorted();
}

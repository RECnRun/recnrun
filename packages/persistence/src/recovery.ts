import { join } from "node:path";
import { JOURNAL_FILE, type GapPayload, type RunCatalogEntry } from "@recnrun/protocol";
import { flowPaths } from "./flow-folders.ts";
import type { FlowStore } from "./flow-store.ts";
import { interruptedResult, recoveryGap } from "./interrupted-run.ts";
import { openJournal } from "./journal.ts";
import { runFolder } from "./runs.ts";

/** What startup recovery did: runs it closed as interrupted, and runs it could not read. */
export interface RecoveryReport {
  recovered: { flowId: string; runId: string; indeterminate: number }[];
  problems: { flowId: string; runId: string; message: string }[];
}

// The gaps go first, so the journal says why it stops before the summary says the run ended.
async function journalGaps(path: string, runId: string, at: string, gaps: GapPayload[]) {
  const journal = await openJournal(path);
  try {
    for (const [index, gap] of gaps.entries())
      await journal.append(recoveryGap(runId, index + 1, at, gap));
  } finally {
    await journal.close();
  }
}

async function recoverRun(store: FlowStore, { flowId, id: runId }: RunCatalogEntry, at: string) {
  const run = await store.getRun(flowId, runId);
  const flow = await store.getRevision(flowId, run.manifest.flowRevision);
  const folder = runFolder(flowPaths(join(store.root, "flows"), flowId).folder, runId);
  const lastSeq = run.journal.events.at(-1)?.seq;
  const restarted: GapPayload = {
    reason: "producer-restarted",
    startedAt: at,
    ...(lastSeq !== undefined && { lastSeq }),
  };
  const truncated = run.journal.gap ? [{ ...run.journal.gap, startedAt: at }] : [];
  await journalGaps(join(folder, JOURNAL_FILE), runId, at, [...truncated, restarted]);
  const result = interruptedResult(flow, run);
  await store.finishRun(result);
  return result.summary.counts.indeterminate;
}

/**
 * Closes every run a stopped service left without a summary; nothing is re-executed.
 * Call it before the service accepts commands, while no replay can be active.
 */
export async function recoverRuns(store: FlowStore, now: () => Date): Promise<RecoveryReport> {
  const report: RecoveryReport = { recovered: [], problems: [] };
  const running = (await store.listRuns()).filter(({ status }) => status === "running");
  for (const entry of running) {
    const ids = { flowId: entry.flowId, runId: entry.id };
    try {
      const indeterminate = await recoverRun(store, entry, now().toISOString());
      report.recovered.push({ ...ids, indeterminate });
    } catch (error) {
      report.problems.push({ ...ids, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  return report;
}

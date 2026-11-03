import { join, relative, sep } from "node:path";
import {
  JOURNAL_FILE,
  type Event,
  type GapPayload,
  type RunCatalogEntry,
  type StoreProblem,
} from "@recnrun/protocol";
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
  const events: Event[] = gaps.map((gap, index) => recoveryGap(runId, index + 1, at, gap));
  const journal = await openJournal(path);
  try {
    for (const event of events) await journal.append(event);
  } finally {
    await journal.close();
  }
  return events;
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
  const gaps = await journalGaps(join(folder, JOURNAL_FILE), runId, at, [...truncated, restarted]);
  const result = interruptedResult(flow, run, gaps);
  await store.finishRun(result);
  return result.summary.counts.indeterminate;
}

/** The run a rebuild problem is about, when its path is inside flows/<flowId>/runs/<runId>/. */
function unreadableRun(flowsRoot: string, problem: StoreProblem) {
  const [flowId, runs, runId] = relative(flowsRoot, problem.path).split(sep);
  if (flowId === undefined || runs !== "runs" || runId === undefined) return undefined;
  return { flowId, runId, message: problem.message };
}

/**
 * Closes every run a stopped service left without a summary; nothing is re-executed.
 * Call it before the service accepts commands, while no replay can be active.
 */
export async function recoverRuns(store: FlowStore, now: () => Date): Promise<RecoveryReport> {
  const report: RecoveryReport = { recovered: [], problems: [] };
  // A crash can leave a finished run indexed as running or a new run folder unindexed, so the folders decide.
  const rows = await store.rebuildIndex();
  for (const problem of rows.problems) {
    const run = unreadableRun(join(store.root, "flows"), problem);
    if (run) report.problems.push(run);
  }
  const running = rows.runs.filter(({ status }) => status === "running");
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

import { compareRuns, pageRunEvents, type RunEventFilter } from "@recnrun/persistence";
import type { Event, RunComparison } from "@recnrun/protocol";
import { ServiceFailure } from "./dispatch.ts";
import { flowOfRun, type RunDeps } from "./runs.ts";

const DEFAULT_LIMIT = 100;

export interface EventQuery extends RunEventFilter {
  runId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

const badCursor = () =>
  new ServiceFailure("invalid-request", "The cursor is not one this service returned.");

async function storedRun(deps: RunDeps, runId: string) {
  return deps.store().getRun(await flowOfRun(deps, runId), runId);
}

/** A page of the run's journal; `nextCursor` is the journal position of the next match. */
export async function queryEvents(
  deps: RunDeps,
  { runId, cursor, limit, ...filter }: EventQuery,
): Promise<{ events: Event[]; nextCursor?: string }> {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!/^\d+$/.test(cursor ?? "0") || !Number.isSafeInteger(start)) throw badCursor();
  const { journal } = await storedRun(deps, runId);
  const page = pageRunEvents(journal.events, filter, { start, limit: limit ?? DEFAULT_LIMIT });
  if (page === undefined) throw badCursor();
  return page.next === undefined
    ? { events: page.events }
    : { events: page.events, nextCursor: String(page.next) };
}

/** Both runs aligned step by step, with where they first diverge. */
export async function compare(
  deps: RunDeps,
  { baselineRunId, runId }: { baselineRunId: string; runId: string },
): Promise<RunComparison> {
  const baseline = await storedRun(deps, baselineRunId);
  const run = await storedRun(deps, runId);
  if (baseline.manifest.flowId !== run.manifest.flowId)
    throw new ServiceFailure(
      "invalid-request",
      `Run ${runId} replays ${run.manifest.flowId}, not ${baseline.manifest.flowId}.`,
    );
  return compareRuns(baseline, run);
}

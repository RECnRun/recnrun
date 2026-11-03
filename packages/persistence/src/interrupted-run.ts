import {
  PROTOCOL_SCHEMA_VERSION,
  RUN_EXIT_CODES,
  STEP_STATES,
  isReadOnlyStep,
  isStepResult,
  type Event,
  type Flow,
  type GapPayload,
  type RunSummary,
  type StepResult,
} from "@recnrun/protocol";
import type { RunResult, StoredRun } from "./runs.ts";

/** The producer of the gaps recovery writes into a journal it did not start. */
export const RECOVERY_PRODUCER = "service:recovery";

const INTERRUPTED_WRITE = {
  code: "run-interrupted",
  message: "The service stopped before this step finished; its effect on the page is unknown.",
};

/** A gap that recovery appends to the journal of an interrupted run. */
export function recoveryGap(runId: string, seq: number, at: string, payload: GapPayload): Event {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    id: `${RECOVERY_PRODUCER}#${seq}`,
    runId,
    seq,
    source: "service",
    producer: RECOVERY_PRODUCER,
    timestamp: at,
    component: "collector",
    targetId: null,
    frameId: null,
    documentId: null,
    category: "gap",
    type: payload.reason,
    payload,
  };
}

/** The step results the journal recorded, by step id: started ones with their time, finished ones whole. */
function journaledSteps(events: readonly Event[]) {
  const started = new Map<string, string>();
  const finished = new Map<string, StepResult>();
  for (const event of events) {
    if (event.category !== "step" || event.stepId === undefined) continue;
    if (event.type === "step.started") started.set(event.stepId, event.timestamp);
    if (event.type !== "step.finished") continue;
    const { index: _index, ...payload } = event.payload;
    const result = { stepId: event.stepId, ...payload };
    if (isStepResult(result)) finished.set(event.stepId, result);
  }
  return { started, finished };
}

/** Each top-level step's result: a write cut short is indeterminate, anything else unfinished is cancelled. */
export function interruptedSteps(flow: Flow, events: readonly Event[]): StepResult[] {
  const { started, finished } = journaledSteps(events);
  return flow.steps.map((step) => {
    const result = finished.get(step.id);
    if (result) return result;
    const startedAt = started.get(step.id);
    if (startedAt === undefined || isReadOnlyStep(step))
      return { stepId: step.id, status: "cancelled" };
    return { stepId: step.id, status: "indeterminate", startedAt, error: INTERRUPTED_WRITE };
  });
}

function tally(results: readonly StepResult[]): RunSummary["counts"] {
  const states = Object.fromEntries(STEP_STATES.map((state) => [state, 0])) as Omit<
    RunSummary["counts"],
    "total"
  >;
  for (const { status } of results) states[status] += 1;
  return { total: results.length, ...states };
}

/** The run files of a run the service lost: status `interrupted`, ended at its last journal line. */
export function interruptedResult(flow: Flow, run: StoredRun): RunResult {
  const { manifest } = run;
  const steps = interruptedSteps(flow, run.journal.events);
  const last = run.journal.events.at(-1)?.timestamp ?? manifest.startedAt;
  const entries = { schemaVersion: PROTOCOL_SCHEMA_VERSION, runId: manifest.runId } as const;
  const summary: RunSummary = {
    ...entries,
    flowId: manifest.flowId,
    status: "interrupted",
    exitCode: RUN_EXIT_CODES.interrupted,
    startedAt: manifest.startedAt,
    endedAt: last > manifest.startedAt ? last : manifest.startedAt,
    counts: tally(steps),
    failures: steps
      .filter(({ status }) => status === "failed" || status === "indeterminate")
      .map(({ stepId, status, error, evidence }) => ({
        stepId,
        message: error?.message ?? status,
        ...(evidence && { evidence }),
      })),
  };
  return { steps: { ...entries, steps }, coverage: { ...entries, surfaces: [] }, summary };
}

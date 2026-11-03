import {
  PROTOCOL_SCHEMA_VERSION,
  RUN_EXIT_CODES,
  type Event,
  type RunCoverage,
  type RunManifest,
  type RunStatus,
  type RunSteps,
  type RunSummary,
  type StepResult,
} from "@recnrun/protocol";
import { APPLICATION_FAILURES } from "./outcome.ts";

/** The journal of one run; persistence's `JournalWriter` satisfies it. */
export interface ReplayJournal {
  append(event: Event): Promise<void>;
  close(): Promise<void>;
}

/** Where a run is stored; persistence's `FlowStore` satisfies it. */
export interface ReplayRunStore {
  createRun(manifest: RunManifest): Promise<{ journal: ReplayJournal }>;
  finishRun(result: { steps: RunSteps; coverage: RunCoverage; summary: RunSummary }): Promise<void>;
}

export interface RecorderOptions {
  runId: string;
  flowId: string;
  store?: { store: ReplayRunStore; manifest: RunManifest } | undefined;
  /** Sees every journal event as it is written, for live progress. */
  observe?: ((event: Event) => void) | undefined;
  now: () => number;
}

/** Writes step events to the journal and, at the end, steps.json and summary.json. */
export interface Recorder {
  started(stepId: string, index: number): Promise<void>;
  finished(result: StepResult, index: number): Promise<void>;
  /** `problem` is why the run could not start; its steps are all blocked. */
  finish(problem?: RunProblem): Promise<RunSummary>;
}

export interface RunProblem {
  code: string;
  message: string;
}

const PRODUCER = "engine:replay";

type StepEvent = Exclude<Event, { category: "gap" }>;

const iso = (ms: number): string => new Date(ms).toISOString();

/** The run's status from its step results: the first step that did not pass decides it. */
function runStatus(results: readonly StepResult[], problem?: RunProblem): RunStatus {
  if (problem) return "error";
  if (results.some(({ status }) => status === "cancelled")) return "interrupted";
  const stop = results.find(({ status }) => status === "failed" || status === "indeterminate");
  if (!stop) return "passed";
  const blamesApplication =
    stop.status === "failed" && APPLICATION_FAILURES.has(stop.error?.code ?? "");
  return blamesApplication ? "failed" : "error";
}

function counts(results: readonly StepResult[]): RunSummary["counts"] {
  const tally: RunSummary["counts"] = {
    total: results.length,
    pending: 0,
    running: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    indeterminate: 0,
  };
  for (const { status } of results) tally[status] += 1;
  return tally;
}

function failures(results: readonly StepResult[], problem?: RunProblem): RunSummary["failures"] {
  const first = results[0];
  if (problem && first)
    return [{ stepId: first.stepId, message: `${problem.code}: ${problem.message}` }];
  return results
    .filter(({ status }) => status === "failed" || status === "indeterminate")
    .map(({ stepId, status, error, evidence }) => ({
      stepId,
      message: error?.message ?? status,
      ...(evidence && { evidence }),
    }));
}

function stepEnvelope(
  options: RecorderOptions,
  seq: number,
  stepId: string,
): Omit<StepEvent, "type" | "payload"> {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    id: `${PRODUCER}#${seq}`,
    runId: options.runId,
    seq,
    source: "engine",
    producer: PRODUCER,
    timestamp: iso(options.now()),
    actor: "replay" as const,
    component: "engine" as const,
    targetId: null,
    frameId: null,
    documentId: null,
    stepId,
    category: "step" as const,
  };
}

/** Opens the run in the store, when there is one, and records into it. */
export async function openRecorder(options: RecorderOptions): Promise<Recorder> {
  const run = options.store && (await options.store.store.createRun(options.store.manifest));
  const startedAt = options.now();
  const results: StepResult[] = [];
  let seq = 0;
  const emit = async (stepId: string, type: string, payload: Record<string, unknown>) => {
    seq += 1;
    const event: StepEvent = { ...stepEnvelope(options, seq, stepId), type, payload };
    options.observe?.(event);
    await run?.journal.append(event);
  };
  return {
    started: (stepId, index) => emit(stepId, "step.started", { index }),
    async finished(result, index) {
      results.push(result);
      if (result.status === "blocked" || result.status === "cancelled") return;
      const { stepId, ...payload } = result;
      await emit(stepId, "step.finished", { index, ...payload });
    },
    async finish(problem) {
      const status = runStatus(results, problem);
      const runEntries = { schemaVersion: PROTOCOL_SCHEMA_VERSION, runId: options.runId } as const;
      const summary: RunSummary = {
        ...runEntries,
        flowId: options.flowId,
        status,
        exitCode: RUN_EXIT_CODES[status],
        startedAt: iso(startedAt),
        endedAt: iso(options.now()),
        counts: counts(results),
        failures: failures(results, problem),
      };
      if (!run || !options.store) return summary;
      await run.journal.close();
      const coverage: RunCoverage = { ...runEntries, surfaces: [] };
      await options.store.store.finishRun({
        steps: { ...runEntries, steps: results },
        coverage,
        summary,
      });
      return summary;
    },
  };
}

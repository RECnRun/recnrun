import {
  PROTOCOL_SCHEMA_VERSION,
  RUN_EXIT_CODES,
  type BodyEncoding,
  type BodyRef,
  type Event,
  type RunCoverage,
  type RunManifest,
  type RunStatus,
  type RunSteps,
  type RunSummary,
  type SnapshotPayload,
  type StepResult,
} from "@recnrun/protocol";
import { APPLICATION_FAILURES } from "./outcome.ts";

/** The journal of one run; persistence's `JournalWriter` satisfies it. */
export interface ReplayJournal {
  append(event: Event): Promise<void>;
  close(): Promise<void>;
}

/** The run's own blob store; persistence's `BlobStore` satisfies it. */
export interface ReplayBlobs {
  put(
    content: Uint8Array | string,
    meta: { mime: string; encoding: BodyEncoding; maxBytes?: number | undefined },
  ): Promise<BodyRef>;
}

/** Where a run is stored; persistence's `FlowStore` satisfies it. */
export interface ReplayRunStore {
  createRun(
    manifest: RunManifest,
  ): Promise<{ journal: ReplayJournal; blobs?: ReplayBlobs | undefined }>;
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
  /** The run's blob store; undefined when the run is not stored or its store keeps no blobs. */
  readonly blobs: ReplayBlobs | undefined;
  snapshot(stepId: string, payload: SnapshotPayload): Promise<void>;
  /** `problem` is why the run could not start; its steps are all blocked. */
  finish(problem?: RunProblem): Promise<RunSummary>;
}

export interface RunProblem {
  code: string;
  message: string;
}

const PRODUCER = "engine:replay";

type StepEvent = Exclude<Event, { category: "gap" }>;
type Category = "step" | "snapshot";
type Emit = (
  stepId: string,
  type: string,
  payload: Record<string, unknown>,
  category?: Category,
) => Promise<void>;

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
  category: Category,
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
    category,
  };
}

/** Opens the run in the store, when there is one, and records into it. */
export async function openRecorder(options: RecorderOptions): Promise<Recorder> {
  const run = options.store && (await options.store.store.createRun(options.store.manifest));
  const startedAt = options.now();
  const results: StepResult[] = [];
  let seq = 0;
  const emit: Emit = async (stepId, type, payload, category = "step") => {
    seq += 1;
    const event: StepEvent = { ...stepEnvelope(options, seq, stepId, category), type, payload };
    options.observe?.(event);
    await run?.journal.append(event);
  };
  return {
    blobs: run?.blobs,
    started: (stepId, index) => emit(stepId, "step.started", { index }),
    snapshot: (stepId, payload) => emit(stepId, "captured", payload, "snapshot"),
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

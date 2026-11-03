import {
  PROTOCOL_SCHEMA_VERSION,
  RUN_EXIT_CODES,
  tallyCoverage,
  type AdapterEvent,
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
import { APPLICATION_FAILURES, CONNECTION_LOST } from "./outcome.ts";

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
  /** The step that last started; captured evidence belongs to it unless it names its own. */
  currentStep(): string | undefined;
  /** Journals a captured event under its own producer and sequence, outside the step order; answers its write. */
  evidence(event: Event): Promise<void>;
  /** Journals the gap of a lost connection under the adapter's own producer and sequence. */
  lost(event: Extract<AdapterEvent, { type: "connection.lost" }>): void;
  /** `problem` is why the run could not start; its steps are all blocked. */
  finish(problem?: RunProblem): Promise<RunSummary>;
}

export interface RunProblem {
  code: string;
  message: string;
}

const PRODUCER = "engine:replay";
const ADAPTER_PRODUCER = "adapter:connection";

type StepEvent = Exclude<Event, { category: "gap" }>;
type Category = "step" | "snapshot";
type Emit = (
  stepId: string,
  type: string,
  payload: Record<string, unknown>,
  category?: Category,
) => Promise<void>;

const iso = (ms: number): string => new Date(ms).toISOString();

const cutShort = ({ status, error }: StepResult): boolean =>
  status === "cancelled" || error?.code === CONNECTION_LOST;

/** What ends a run: its step results, why it could not start, and whether Chrome went away. */
interface RunEnd {
  results: readonly StepResult[];
  problem: RunProblem | undefined;
  /** The connection was lost at some point, even after the last step passed. */
  lost: boolean;
}

/** The run's status from its step results: the first step that did not pass decides it. */
function runStatus({ results, problem, lost }: RunEnd): RunStatus {
  if (problem) return "error";
  if (lost || results.some(cutShort)) return "interrupted";
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

// A cancelled step with an error was cut short; its error names the cause.
const FAILURES: ReadonlySet<string> = new Set(["failed", "indeterminate"]);

function failures(results: readonly StepResult[], problem?: RunProblem): RunSummary["failures"] {
  const first = results[0];
  if (problem && first)
    return [{ stepId: first.stepId, message: `${problem.code}: ${problem.message}` }];
  return results
    .filter(({ status, error }) => FAILURES.has(status) || (status === "cancelled" && error))
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

function lostEvent(
  runId: string,
  event: Extract<AdapterEvent, { type: "connection.lost" }>,
): Event {
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    id: `${ADAPTER_PRODUCER}#${event.seq}`,
    runId,
    seq: event.seq,
    source: "adapter",
    producer: ADAPTER_PRODUCER,
    timestamp: event.at,
    component: "collector",
    targetId: null,
    frameId: null,
    documentId: null,
    category: "gap",
    type: event.gap.reason,
    payload: event.gap,
  };
}

/** Journal lines and their coverage counts; a gap written outside the step order is awaited at finish. */
function journalWriter(
  options: RecorderOptions,
  journal?: { append(event: Event): Promise<void> },
) {
  const tally = tallyCoverage();
  const pending = new Set<Promise<void>>();
  const write = async (event: Event) => {
    tally.add(event);
    options.observe?.(event);
    await journal?.append(event);
  };
  // Answers the write itself, so the capture can account for a failed one; finish waits regardless.
  const detached = (event: Event) => {
    const line = write(event);
    const settled = line.catch(() => {});
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
    return line;
  };
  return { tally, write, detached, settled: () => Promise.all(pending) };
}

function summarize(options: RecorderOptions, startedAt: number, end: RunEnd): RunSummary {
  const { results, problem } = end;
  const status = runStatus(end);
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    runId: options.runId,
    flowId: options.flowId,
    status,
    exitCode: RUN_EXIT_CODES[status],
    startedAt: iso(startedAt),
    endedAt: iso(options.now()),
    counts: counts(results),
    failures: failures(results, problem),
  };
}

/** Opens the run in the store, when there is one, and records into it. */
export async function openRecorder(options: RecorderOptions): Promise<Recorder> {
  const run = options.store && (await options.store.store.createRun(options.store.manifest));
  const startedAt = options.now();
  const results: StepResult[] = [];
  const writer = journalWriter(options, run?.journal);
  let seq = 0;
  let current: string | undefined;
  let lost = false;
  const emit: Emit = async (stepId, type, payload, category = "step") => {
    seq += 1;
    await writer.write({ ...stepEnvelope(options, seq, stepId, category), type, payload });
  };
  return {
    blobs: run?.blobs,
    started: (stepId, index) => {
      current = stepId;
      return emit(stepId, "step.started", { index });
    },
    currentStep: () => current,
    evidence: (event) => writer.detached(event),
    snapshot: (stepId, payload) => emit(stepId, "captured", payload, "snapshot"),
    lost: (event) => {
      lost = true;
      void writer.detached(lostEvent(options.runId, event));
    },
    async finished(result, index) {
      results.push(result);
      // A step that never started has nothing to close in the journal.
      if (result.startedAt === undefined) return;
      const { stepId, ...payload } = result;
      await emit(stepId, "step.finished", { index, ...payload });
    },
    async finish(problem) {
      const runEntries = { schemaVersion: PROTOCOL_SCHEMA_VERSION, runId: options.runId } as const;
      const summary = summarize(options, startedAt, { results, problem, lost });
      await writer.settled();
      if (!run || !options.store) return summary;
      await run.journal.close();
      const coverage: RunCoverage = writer.tally.coverage(options.runId);
      await options.store.store.finishRun({
        steps: { ...runEntries, steps: results },
        coverage,
        summary,
      });
      return summary;
    },
  };
}

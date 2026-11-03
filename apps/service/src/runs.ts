import { randomUUID } from "node:crypto";
import {
  applySessionEvent,
  createSession,
  replayFlow,
  type ReplayControl,
  type ReplayRunStore,
} from "@recnrun/engine";
import type { FlowStore, JournalWriter } from "@recnrun/persistence";
import {
  PROTOCOL_SCHEMA_VERSION,
  RUN_EXIT_CODES,
  checkInputValues,
  type Event,
  type RunManifest,
  type RunSummary,
} from "@recnrun/protocol";
import { endpointOf, type BrowserPort } from "./browser.ts";
import { ServiceFailure } from "./dispatch.ts";
import type { EventHub } from "./hub.ts";
import type { JournalRegistry } from "./journals.ts";
import type { Logger } from "./logger.ts";
import { SERVICE_VERSION } from "./version.ts";

/** A replay this service started; `summary` or `error` is set once it ends. */
interface RunRecord {
  flowId: string;
  summary?: RunSummary;
  error?: string;
  /** Lets no further step start; set while the replay runs. */
  cancel?: () => void;
}

export interface RunDeps {
  browser: BrowserPort;
  hub: EventHub;
  journals: JournalRegistry;
  logger: Logger;
  store: () => FlowStore;
  now: () => number;
  runs: Map<string, RunRecord>;
  /** Replays still running, so stopping the service waits for them. */
  active: Set<Promise<void>>;
}

export interface ReplayParams {
  flowId: string;
  dataset?: string | undefined;
  inputs?: Record<string, unknown> | undefined;
  /** Transient: forwarded only to the executor, never stored or logged. */
  secrets?: Record<string, string> | undefined;
}

type RunValues = Pick<ReplayParams, "inputs" | "secrets">;

/** The service tracks the run's journal, so stopping closes it even when the replay cannot. */
function owned(
  store: FlowStore,
  journals: JournalRegistry,
  opened: JournalWriter[],
): ReplayRunStore {
  return {
    createRun: async (manifest) => {
      const { journal, blobs } = await store.createRun(manifest);
      const tracked = await journals.adopt(journal);
      opened.push(tracked);
      return { journal: tracked, blobs };
    },
    finishRun: (result) => store.finishRun(result),
  };
}

/** A replay runs as a started session; cancelling interrupts it, so no further step starts. */
function cancellable(record: RunRecord): ReplayControl {
  const started = applySessionEvent(createSession(), "start");
  if (!started.ok) throw new Error("A new session cannot start.");
  let session = started.session;
  let wake = () => {};
  const changed = new Promise<void>((resolve) => (wake = resolve));
  record.cancel = () => {
    const interrupted = applySessionEvent(session, "interrupt");
    if (interrupted.ok) session = interrupted.session;
    wake();
  };
  return { session: () => session, changed: () => changed };
}

/** What a replay reported before it failed: its steps, and the status of each that finished. */
interface Progress {
  steps: string[];
  finished: string[];
}

const COUNTED = ["passed", "failed", "indeterminate"] as const;

function note(progress: Progress, event: Event): void {
  if (event.category === "gap" || event.type !== "step.finished") return;
  const status = event.payload["status"];
  if (typeof status === "string") progress.finished.push(status);
}

/** The summary of a replay that failed outside its steps, blamed on its first step as the engine does. */
function failedSummary(
  deps: RunDeps,
  manifest: RunManifest,
  progress: Progress,
  message: string,
): RunSummary {
  const total = progress.steps.length;
  const tally = (status: string) => progress.finished.filter((each) => each === status).length;
  const [passed, failed, indeterminate] = COUNTED.map(tally);
  const [first] = progress.steps;
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    runId: manifest.runId,
    flowId: manifest.flowId,
    status: "error",
    exitCode: RUN_EXIT_CODES.error,
    startedAt: manifest.startedAt,
    endedAt: new Date(deps.now()).toISOString(),
    counts: {
      total,
      pending: total - progress.finished.length,
      running: 0,
      passed: passed ?? 0,
      failed: failed ?? 0,
      blocked: 0,
      cancelled: 0,
      indeterminate: indeterminate ?? 0,
    },
    failures: first === undefined ? [] : [{ stepId: first, message }],
  };
}

/** Interrupts every replay still running, for the service's shutdown. */
export function cancelReplays(deps: RunDeps): void {
  for (const record of deps.runs.values()) record.cancel?.();
}

async function execute(
  deps: RunDeps,
  manifest: RunManifest,
  endpoint: string,
  { inputs, secrets }: RunValues,
) {
  const store = deps.store();
  const { runId, flowId } = manifest;
  const record: RunRecord = { flowId };
  deps.runs.set(runId, record);
  const control = cancellable(record);
  const opened: JournalWriter[] = [];
  const progress: Progress = { steps: [], finished: [] };
  try {
    const flow = await store.getRevision(flowId, manifest.flowRevision);
    progress.steps = flow.steps.map(({ id }) => id);
    const connection = await deps.browser.replayDriver(endpoint);
    try {
      const outcome = await replayFlow(connection.driver, flow, {
        runId,
        inputs,
        secrets,
        run: { store: owned(store, deps.journals, opened), manifest },
        control,
        observe: (event) => {
          note(progress, event);
          deps.hub.publish({ type: "run.step", runId, event });
        },
      });
      record.summary = outcome.summary;
      deps.hub.publish({ type: "run.finished", runId, summary: outcome.summary });
    } finally {
      await connection.close();
    }
  } catch (error) {
    record.error = (error instanceof Error ? error.message : String(error)) || "The replay failed.";
    deps.logger.error("run.failed", { runId, message: record.error });
    // Subscribers wait for run.finished, so a replay that failed still ends with one.
    const summary = failedSummary(deps, manifest, progress, record.error);
    deps.hub.publish({ type: "run.finished", runId, summary });
  } finally {
    delete record.cancel;
    // A replay that failed before finishing left its journal open.
    await Promise.allSettled(opened.map((journal) => journal.close()));
  }
}

/** Starts a replay of the flow's current revision and answers with its run id at once. */
export async function startReplay(deps: RunDeps, params: ReplayParams): Promise<{ runId: string }> {
  const store = deps.store();
  const { flow, revision } = await store.get(params.flowId);
  // The store checks the dataset against the flow; the request's own inputs are checked here.
  const issues = checkInputValues(flow, params.inputs ?? {});
  if (issues.length > 0) {
    throw new ServiceFailure("invalid-request", issues.map(({ message }) => message).join(" "));
  }
  const dataset =
    params.dataset === undefined
      ? undefined
      : await store.getDataset(params.flowId, params.dataset);
  // Inputs given with the request override the dataset's.
  const inputs = { ...dataset?.inputs, ...params.inputs };
  const endpoint = await endpointOf(deps.browser);
  const runId = `run-${randomUUID()}`;
  const manifest: RunManifest = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    runId,
    flowId: params.flowId,
    flowRevision: revision,
    startedAt: new Date(deps.now()).toISOString(),
    captureLevel: "normal",
    ...(params.dataset !== undefined && { dataset: params.dataset }),
    versions: { engine: SERVICE_VERSION, protocol: PROTOCOL_SCHEMA_VERSION, node: process.version },
    bindings: {},
  };
  const done = execute(deps, manifest, endpoint, { inputs, secrets: params.secrets });
  deps.active.add(done);
  void done.finally(() => deps.active.delete(done));
  return { runId };
}

/** The flow a run belongs to: this process's runs first, then the store's index. */
export async function flowOfRun(deps: RunDeps, runId: string): Promise<string> {
  const known = deps.runs.get(runId)?.flowId;
  if (known !== undefined) return known;
  const entry = (await deps.store().listRuns()).find(({ id }) => id === runId);
  if (entry === undefined) throw new ServiceFailure("not-found", `No run ${runId}.`);
  return entry.flowId;
}

/** A finished run's summary; a run still going is a `conflict` the caller polls past. */
export async function runSummary(deps: RunDeps, runId: string): Promise<RunSummary> {
  const record = deps.runs.get(runId);
  if (record?.summary) return record.summary;
  if (record?.error !== undefined) throw new ServiceFailure("internal", record.error);
  if (record) throw new ServiceFailure("conflict", `Run ${runId} is still running.`);
  const stored = await deps.store().getRun(await flowOfRun(deps, runId), runId);
  if (stored.summary === undefined)
    throw new ServiceFailure("conflict", `Run ${runId} has no summary; it did not finish.`);
  return stored.summary;
}

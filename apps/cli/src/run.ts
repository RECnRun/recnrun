import { RUN_EXIT_CODES, type Flow, type RunSummary } from "@recnrun/protocol";
import { ServiceCallError, type ServiceClient } from "@recnrun/service";

const POLL_MS = 250;
// A run that has not finished answers run.summary with one of these.
const UNFINISHED = new Set(["conflict", "not-found"]);

export interface RunOptions {
  flow: string;
  dataset: string | undefined;
  timeoutMs: number;
}

export interface RunDeps {
  load(path: string): Promise<Flow>;
  connect(): Promise<{ client: Pick<ServiceClient, "call">; close(): Promise<void> }>;
  out(line: string): void;
  err(line: string): void;
  pause(ms: number): Promise<void>;
  now(): number;
}

const describe = (error: unknown): string => {
  if (error instanceof ServiceCallError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

async function waitForSummary(
  client: Pick<ServiceClient, "call">,
  runId: string,
  { timeoutMs }: RunOptions,
  deps: RunDeps,
): Promise<RunSummary | undefined> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    try {
      return await client.call("run.summary", { runId });
    } catch (error) {
      if (!(error instanceof ServiceCallError) || !UNFINISHED.has(error.code)) throw error;
    }
    if (deps.now() >= deadline) return undefined;
    await deps.pause(POLL_MS);
  }
}

async function replay(options: RunOptions, deps: RunDeps): Promise<number> {
  const flow = await deps.load(options.flow);
  const connection = await deps.connect();
  try {
    // The file is the source of truth for this run, so the store gets its content first.
    await connection.client.call("flow.import", { flow });
    const params = options.dataset === undefined ? {} : { dataset: options.dataset };
    const { runId } = await connection.client.call("flow.replay", { flowId: flow.id, ...params });
    deps.err(`Run ${runId} of flow ${flow.id} started.`);
    const summary = await waitForSummary(connection.client, runId, options, deps);
    if (summary === undefined) {
      deps.err(`Run ${runId} did not finish within ${options.timeoutMs / 1000} s.`);
      return 2;
    }
    deps.out(JSON.stringify(summary));
    deps.err(`Run ${runId} ${summary.status}.`);
    return RUN_EXIT_CODES[summary.status];
  } finally {
    await connection.close();
  }
}

/** Replays a flow through the service; stdout gets the summary JSON, stderr the progress. */
export async function runFlow(options: RunOptions, deps: RunDeps): Promise<number> {
  try {
    return await replay(options, deps);
  } catch (error) {
    deps.err(`recnrun run failed: ${describe(error)}`);
    return 2;
  }
}

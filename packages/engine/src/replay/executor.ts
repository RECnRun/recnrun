import type {
  Event,
  Flow,
  RunManifest,
  RunStatus,
  RunSummary,
  SnapshotMilestone,
  Step,
  StepResult,
  StepState,
} from "@recnrun/protocol";
import { stepTransition, type StepEvent } from "../machines.ts";
import { mayStartNextStep, type Session } from "../session.ts";
import type { ReplayDriver } from "./driver.ts";
import type { StepOutcome } from "./outcome.ts";
import {
  openRecorder,
  type Recorder,
  type RecorderOptions,
  type ReplayRunStore,
  type RunProblem,
} from "./record.ts";
import { createScope, redact, secretValues, type Scope, type ScopeOptions } from "./scope.ts";
import { snapshotter, type Snapshotter } from "./snapshots.ts";
import { executeStep } from "./step.ts";
import { deadlineIn, systemClock, type Clock } from "./wait.ts";

/** Lets a session pause the executor between steps (`pauseReplay`), never in the middle of one. */
export interface ReplayControl {
  session(): Session;
  /** Resolves when the session may have changed; the executor then reads it again. */
  changed(): Promise<void>;
}

export interface ReplayOptions extends ScopeOptions {
  clock?: Clock;
  /** A step's deadline when it sets no `timeoutMs`. */
  defaultTimeoutMs?: number;
  /** Ids the events and the summary carry when no store is given. */
  runId?: string;
  /** Stores the run: the manifest is written first, steps.json and summary.json last. */
  run?: { store: ReplayRunStore; manifest: RunManifest };
  control?: ReplayControl;
  /** Sees every journal line as it is written: step events and the run's evidence alike. */
  observe?: (event: Event) => void;
}

export interface ReplayOutcome {
  status: RunStatus;
  exitCode: 0 | 1 | 2;
  steps: StepResult[];
  /** Extracted variables, with every secret value redacted. */
  vars: Record<string, string>;
  summary: RunSummary;
  /** Why no step ran: every step is then `blocked`. */
  error?: RunProblem;
}

export const DEFAULT_STEP_TIMEOUT_MS = 10_000;

const OUTCOME_EVENTS: Readonly<Record<StepOutcome["status"], StepEvent>> = {
  passed: "pass",
  failed: "fail",
  indeterminate: "outcomeUnknown",
};

/** Moves a step through the F2.2 step machine; an illegal move is a defect of the executor. */
function advance(state: StepState, event: StepEvent): StepState {
  const next = stepTransition(state, event);
  if (!next.ok) throw new Error(`Step machine: ${event} is illegal in ${state}.`);
  return next.state;
}

// One driver means one browser, so a flow that needs several actors cannot run until F4.3.
function preflight(flow: Flow, scope: Scope | { missing: string }): RunProblem | undefined {
  const named = new Set(flow.steps.flatMap((step) => (step.actor ? [step.actor] : [])));
  const undeclared = [...named].find((actor) => !Object.hasOwn(flow.actors, actor));
  if (undeclared) {
    const message = `Step actor ${JSON.stringify(undeclared)} is not declared in the flow.`;
    return { code: "multi-actor-unsupported", message };
  }
  if (named.size > 1) {
    const message = `The steps use ${named.size} actors; binding-aware dispatch is F4.3.`;
    return { code: "multi-actor-unsupported", message };
  }
  const block = flow.steps.find((step) => "builtin" in step);
  if (block)
    return { code: "unsupported-step", message: `Step ${block.id}: control blocks are F4A.4.` };
  if ("missing" in scope)
    return { code: "missing-input", message: `Input ${scope.missing} has no value.` };
  return undefined;
}

/** Waits while `pauseReplay` holds; false when the session stopped instead of resuming. */
async function mayStart(control: ReplayControl | undefined): Promise<boolean> {
  if (!control) return true;
  for (;;) {
    const session = control.session();
    if (mayStartNextStep(session)) return true;
    if (session.state !== "recording" && session.state !== "paused") return false;
    await control.changed();
  }
}

function redactResult(result: StepResult, secrets: readonly string[]): StepResult {
  const error = result.error && { ...result.error, message: redact(result.error.message, secrets) };
  const evidence = result.evidence?.map((item) => redact(item, secrets));
  return { ...result, ...(error && { error }), ...(evidence && { evidence }) };
}

interface Run {
  driver: ReplayDriver;
  scope: Scope;
  secrets: string[];
  clock: Clock;
  timeoutMs: number;
  recorder: Recorder;
  snapshot: Snapshotter | undefined;
}

// Actions are captured before and after; any step that does not pass is captured on failure.
async function capture(run: Run, step: Step, milestone: SnapshotMilestone): Promise<void> {
  if (!run.snapshot) return;
  if (milestone !== "failure" && !("action" in step)) return;
  await run.snapshot(step.id, milestone);
}

async function runStep(run: Run, step: Step, index: number): Promise<StepResult> {
  let state = advance("pending", "start");
  await run.recorder.started(step.id, index);
  await capture(run, step, "before");
  const startedAt = run.clock.now();
  const deadline = deadlineIn(step.timeoutMs ?? run.timeoutMs, run.clock);
  const outcome = await executeStep(step, { driver: run.driver, scope: run.scope, deadline });
  state = advance(state, OUTCOME_EVENTS[outcome.status]);
  const endedAt = run.clock.now();
  await capture(run, step, "after");
  if (state !== "passed") await capture(run, step, "failure");
  const result: StepResult = {
    stepId: step.id,
    ...outcome,
    status: state,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
  };
  return redactResult(result, run.secrets);
}

/** Records the steps that never start: `blocked` after a failure, `cancelled` after a stop. */
async function skip(run: Run, steps: readonly Step[], from: number, event: "block" | "cancel") {
  for (let index = from; index < steps.length; index += 1) {
    const step = steps[index] as Step;
    await run.recorder.finished({ stepId: step.id, status: advance("pending", event) }, index);
  }
}

async function runAll(
  run: Run,
  steps: readonly Step[],
  control?: ReplayControl,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    if (!(await mayStart(control))) {
      await skip(run, steps, index, "cancel");
      break;
    }
    const result = await runStep(run, step, index);
    results.push(result);
    await run.recorder.finished(result, index);
    if (result.status !== "passed") {
      await skip(run, steps, index + 1, "block");
      break;
    }
  }
  return results;
}

function recorderOptions(flow: Flow, options: ReplayOptions, clock: Clock): RecorderOptions {
  return {
    runId: options.run?.manifest.runId ?? options.runId ?? "replay",
    flowId: flow.id,
    store: options.run,
    observe: options.observe,
    now: () => clock.now(),
  };
}

/** The run's scope, and why the run cannot start, if it cannot. */
function prepare(flow: Flow, options: ReplayOptions): { scope: Scope; problem?: RunProblem } {
  const created = createScope(flow, options);
  const problem = preflight(flow, created);
  const scope = "missing" in created ? { env: {}, inputs: {}, vars: {}, secrets: {} } : created;
  return { scope, ...(problem && { problem }) };
}

/**
 * Replays a flow's steps in order through the driver. Reads (locating, assertions, waits) poll
 * until the step's deadline; a write is dispatched once and never again, and one whose effect is
 * unknown leaves the step `indeterminate`. The first step that does not pass stops the run.
 */
export async function replayFlow(
  driver: ReplayDriver,
  flow: Flow,
  options: ReplayOptions = {},
): Promise<ReplayOutcome> {
  const clock = options.clock ?? systemClock;
  const recorder = await openRecorder(recorderOptions(flow, options, clock));
  const { scope, problem } = prepare(flow, options);
  const secrets = secretValues(flow, scope);
  const timeoutMs = options.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const snapshot = snapshotter(driver, recorder, secrets);
  const run: Run = { driver, scope, secrets, clock, timeoutMs, recorder, snapshot };
  const stopListening = driver.onEvent?.((event) => {
    if (event.type === "connection.lost") recorder.lost(event);
  });
  if (problem) await skip(run, flow.steps, 0, "block");
  const steps = problem
    ? []
    : await runAll(run, flow.steps, options.control).finally(stopListening);
  stopListening?.();
  const summary = await recorder.finish(problem);
  const vars = Object.fromEntries(
    Object.entries(scope.vars).map(([name, value]) => [name, redact(value, secrets)]),
  );
  return {
    status: summary.status,
    exitCode: summary.exitCode,
    steps: problem ? [] : steps,
    vars,
    summary,
    ...(problem && { error: problem }),
  };
}

import {
  parseInterpolations,
  type ActionStep,
  type Flow,
  type RunStatus,
  type Step,
  type StepResult,
  type Target,
} from "@recnrun/protocol";

/** The browser operations the replay spike needs; `BrowserAdapter` has them. */
export interface ReplayDriver {
  navigate(url: string): Promise<void>;
  fill(target: Target, value: string): Promise<void>;
  click(target: Target): Promise<void>;
  readText(target: Target): Promise<string>;
}

export interface ReplayOptions {
  env?: Record<string, string>;
  inputs?: Record<string, string>;
  now?: () => Date;
}

export interface ReplayOutcome {
  status: Exclude<RunStatus, "interrupted">;
  steps: StepResult[];
  vars: Record<string, string>;
  /** Set when the run could not start; no step ran. */
  error?: { code: string; message: string };
}

type Values = Record<string, string>;
type Scope = { readonly env: Values; readonly inputs: Values; readonly vars: Values };
type Outcome = Pick<StepResult, "status" | "error" | "evidence">;

// The one failure code that means the application misbehaved; every other code is a run error.
const ASSERTION_FAILED = "assertion-failed";
const PASSED: Outcome = { status: "passed" };

/** A failure the runner raises itself, with the code it reports. */
class ReplayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const quoted = (label: string, text: string) => `${label}: ${JSON.stringify(text)}`;

function lookup(scope: Scope, namespace: string, path: string[]): string | undefined {
  const values = Object.hasOwn(scope, namespace) ? scope[namespace as keyof Scope] : undefined;
  const [name = "", ...rest] = path;
  if (!values || rest.length > 0 || !Object.hasOwn(values, name)) return undefined;
  return values[name];
}

/** Resolves `${env|inputs|vars.<name>}`; anything else, secrets included, is unresolved here. */
function interpolate(text: string, scope: Scope): string {
  let resolved = "";
  let from = 0;
  for (const { raw, namespace, path, start } of parseInterpolations(text)) {
    const value = lookup(scope, namespace, path);
    if (value === undefined) {
      throw new ReplayError("unresolved-variable", `${raw} has no value in this run.`);
    }
    resolved += text.slice(from, start) + value;
    from = start + raw.length;
  }
  return resolved + text.slice(from);
}

async function act(driver: ReplayDriver, step: ActionStep, scope: Scope): Promise<Outcome> {
  if (step.action === "navigate") {
    await driver.navigate(interpolate(step.url, scope));
    return PASSED;
  }
  if (step.action === "fill") {
    await driver.fill(step.target, interpolate(step.value, scope));
    return PASSED;
  }
  if (step.action === "click") {
    await driver.click(step.target);
    return PASSED;
  }
  if (step.action === "extractText") {
    const text = await driver.readText(step.target);
    scope.vars[step.saveAs] = text;
    return { status: "passed", evidence: [quoted("observed", text)] };
  }
  throw new ReplayError("unsupported-step", `The replay spike cannot run ${step.action}.`);
}

async function execute(driver: ReplayDriver, step: Step, scope: Scope): Promise<Outcome> {
  if ("action" in step) return act(driver, step, scope);
  if (!("assertion" in step) || step.assertion !== "textEquals") {
    const kind = "assertion" in step ? step.assertion : step.builtin;
    throw new ReplayError("unsupported-step", `The replay spike cannot run ${kind}.`);
  }
  const expected = interpolate(step.expected, scope);
  const observed = await driver.readText(step.target);
  if (observed === expected) return { status: "passed", evidence: [quoted("observed", observed)] };
  return {
    status: "failed",
    error: {
      code: ASSERTION_FAILED,
      message: `Expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}.`,
    },
    evidence: [quoted("expected", expected), quoted("observed", observed)],
  };
}

function failure(error: unknown): Outcome {
  const code = error instanceof ReplayError ? error.code : "adapter-error";
  const message = (error instanceof Error ? error.message : String(error)) || "Unknown error.";
  return { status: "failed", error: { code, message } };
}

async function runStep(
  driver: ReplayDriver,
  step: Step,
  scope: Scope,
  now: () => Date,
): Promise<StepResult> {
  const startedAt = now();
  const outcome = await execute(driver, step, scope).catch(failure);
  const endedAt = now();
  return {
    stepId: step.id,
    ...outcome,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
  };
}

function runStatus(last: StepResult | undefined): ReplayOutcome["status"] {
  if (!last || last.status === "passed") return "passed";
  return last.error?.code === ASSERTION_FAILED ? "failed" : "error";
}

// One driver means one browser, so a flow that needs several actors cannot run until F4.3.
function actorProblem(flow: Flow): string | undefined {
  const named = new Set(flow.steps.flatMap((step) => (step.actor ? [step.actor] : [])));
  const undeclared = [...named].find((actor) => !Object.hasOwn(flow.actors, actor));
  if (undeclared) return `Step actor ${JSON.stringify(undeclared)} is not declared in the flow.`;
  if (named.size > 1) return `The steps use ${named.size} actors; binding-aware dispatch is F4.3.`;
  return undefined;
}

/**
 * The F1.6 spike executor: runs top-level steps in order and stops at the first that does not
 * pass. F2.5 replaces it with the full executor (waits, every action, polling assertions).
 */
export async function runSteps(
  driver: ReplayDriver,
  flow: Flow,
  options: ReplayOptions = {},
): Promise<ReplayOutcome> {
  const problem = actorProblem(flow);
  if (problem) {
    return {
      status: "error",
      steps: [],
      vars: {},
      error: { code: "multi-actor-unsupported", message: problem },
    };
  }
  const scope: Scope = { env: options.env ?? {}, inputs: options.inputs ?? {}, vars: {} };
  const now = options.now ?? (() => new Date());
  const steps: StepResult[] = [];
  for (const step of flow.steps) {
    const result = await runStep(driver, step, scope, now);
    steps.push(result);
    if (result.status !== "passed") break;
  }
  return { status: runStatus(steps.at(-1)), steps, vars: scope.vars };
}

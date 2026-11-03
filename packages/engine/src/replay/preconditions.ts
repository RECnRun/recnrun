import type { Precondition, Target } from "@recnrun/protocol";
import type { ReplayDriver } from "./driver.ts";
import { currentUrl, describeState, urlMatches } from "./locate.ts";
import { StepFailure } from "./outcome.ts";
import type { RunProblem } from "./record.ts";
import { interpolate, interpolateTarget, redact, type Scope } from "./scope.ts";
import {
  beforeDeadline,
  deadlineIn,
  pollUntil,
  readTimeout,
  type Clock,
  type Deadline,
} from "./wait.ts";

/** The run problem of a declared check that did not hold: no step runs, every step is blocked. */
export const PRECONDITION_FAILED = "precondition-failed";

interface Check {
  readonly driver: ReplayDriver;
  readonly scope: Scope;
  readonly deadline: Deadline;
}

/** What a precondition needs from the run: the driver, the values, the clock, and the loss. */
export interface PreconditionRun {
  driver: ReplayDriver;
  scope: Scope;
  secrets: readonly string[];
  clock: Clock;
  timeoutMs: number;
  lost?: (() => boolean) | undefined;
}

/** A function check has no runtime before F4A.3; the run refuses it before anything is dispatched. */
export function unsupportedPrecondition(
  preconditions: readonly Precondition[],
): RunProblem | undefined {
  const fn = preconditions.find(({ check }) => "functionRef" in check);
  if (!fn) return undefined;
  const message = `Precondition authenticated: ${fn.authenticated}: function checks run from F4A.3 on.`;
  return { code: "unsupported-precondition", message };
}

// Reads never open a tab, so the check opens its URL first; a wildcard URL can only be compared.
async function open(url: string, { driver, deadline }: Check): Promise<string | undefined> {
  if (url.includes("*")) return undefined;
  const command = { kind: "navigate", url } as const;
  const navigation = driver.act(command, readTimeout(deadline));
  const result = await beforeDeadline(navigation, deadline, "The navigation");
  if (result.status === "done") return undefined;
  return `${url} could not be opened: ${result.message}`;
}

async function checkUrl(expected: string, check: Check): Promise<string | undefined> {
  const opened = await open(expected, check);
  if (opened) return opened;
  const { driver, deadline } = check;
  const poll = await pollUntil(
    async () => currentUrl(await driver.tabs(readTimeout(deadline))),
    (url) => urlMatches(url, expected),
    deadline,
  );
  if (poll.met) return undefined;
  const seen = poll.value === undefined ? "could not be read" : `is ${poll.value}`;
  return `the URL never matched ${JSON.stringify(expected)}; it ${seen}.`;
}

async function checkVisible(
  target: Target,
  url: string | undefined,
  check: Check,
): Promise<string | undefined> {
  const opened = url === undefined ? undefined : await open(url, check);
  if (opened) return opened;
  const { driver, deadline } = check;
  const poll = await pollUntil(
    () => driver.inspect(target, readTimeout(deadline)),
    (state) => state.count === 1 && state.visible,
    deadline,
  );
  if (poll.met) return undefined;
  const seen = poll.value === undefined ? "the page could not be read" : describeState(poll.value);
  return `${JSON.stringify(target)} is not visible: ${seen}.`;
}

/** Why the check did not hold, or undefined when it did; the values are resolved first. */
function checkOne({ check }: Precondition, context: Check): Promise<string | undefined> {
  const { scope } = context;
  if ("visible" in check) {
    const url = check.url === undefined ? undefined : interpolate(check.url, scope);
    return checkVisible(interpolateTarget(check.visible, scope), url, context);
  }
  if ("url" in check) return checkUrl(interpolate(check.url, scope), context);
  throw new StepFailure("unsupported-precondition", "function checks run from F4A.3 on.");
}

/**
 * Proves each precondition in the actor's Chrome before any step runs, each under its own
 * deadline of the run's default step timeout. The first that does not hold ends the run.
 */
export async function checkPreconditions(
  preconditions: readonly Precondition[],
  run: PreconditionRun,
): Promise<RunProblem | undefined> {
  for (const precondition of preconditions) {
    const prefix = `Precondition authenticated: ${precondition.authenticated}`;
    const deadline = deadlineIn(run.timeoutMs, run.clock, run.lost);
    const context: Check = { driver: run.driver, scope: run.scope, deadline };
    try {
      const detail = await checkOne(precondition, context);
      if (detail)
        return { code: PRECONDITION_FAILED, message: redact(`${prefix}: ${detail}`, run.secrets) };
    } catch (error) {
      const code = error instanceof StepFailure ? error.code : "adapter-error";
      const message = error instanceof Error ? error.message : String(error);
      return { code, message: redact(`${prefix}: ${message}`, run.secrets) };
    }
  }
  return undefined;
}

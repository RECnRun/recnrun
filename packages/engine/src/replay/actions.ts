import type { ActionStep, Target } from "@recnrun/protocol";
import type { ActResult, DriverCommand } from "./driver.ts";
import { locate, matchTab, unmet, type Readiness } from "./locate.ts";
import { failed, passed, StepFailure, type StepOutcome } from "./outcome.ts";
import { interpolate, interpolateTarget, type Scope } from "./scope.ts";
import type { StepContext } from "./step-context.ts";
import { beforeDeadline, pollUntil, readTimeout, remaining } from "./wait.ts";

/** A write: the command, and the element it needs ready before it is dispatched. */
interface Write {
  command: DriverCommand;
  target?: Target | undefined;
  readiness?: Readiness | undefined;
}

type WriteStep = Exclude<
  ActionStep,
  { action: "waitFor" | "selectTab" | "extractText" | "extractAttribute" }
>;

const optionalUrl = (url: string | undefined, scope: Scope) =>
  url === undefined ? undefined : interpolate(url, scope);

const optionalTarget = (target: Target | undefined, scope: Scope) =>
  target === undefined ? undefined : interpolateTarget(target, scope);

type ElementWrite = Extract<
  WriteStep,
  { action: "click" | "check" | "uncheck" | "fill" | "type" | "select" }
>;
type PageWrite = Exclude<WriteStep, ElementWrite>;

const ELEMENT_WRITES: ReadonlySet<string> = new Set([
  "click",
  "check",
  "uncheck",
  "fill",
  "type",
  "select",
]);

const isElementWrite = (step: WriteStep): step is ElementWrite => ELEMENT_WRITES.has(step.action);

function planElementWrite(step: ElementWrite, scope: Scope): Write {
  const target = interpolateTarget(step.target, scope);
  if (!("value" in step)) {
    return { command: { kind: step.action, target }, target, readiness: "actionable" };
  }
  const command = { kind: step.action, target, value: interpolate(step.value, scope) };
  return { command, target, readiness: step.action === "select" ? "actionable" : "editable" };
}

function planPageWrite(step: PageWrite, scope: Scope): Write {
  if (step.action === "navigate") {
    return { command: { kind: "navigate", url: interpolate(step.url, scope) } };
  }
  if (step.action === "openTab") {
    return { command: { kind: "openTab", url: optionalUrl(step.url, scope) } };
  }
  if (step.action === "keyPress") {
    const target = optionalTarget(step.target, scope);
    return {
      command: { kind: "keyPress", key: step.key, target },
      target,
      readiness: "actionable",
    };
  }
  if (step.action === "scroll") {
    const target = optionalTarget(step.target, scope);
    const deltas = { deltaX: step.deltaX ?? 0, deltaY: step.deltaY ?? 0 };
    return { command: { kind: "scroll", target, ...deltas }, target, readiness: "attached" };
  }
  return { command: { kind: step.action } };
}

function planWrite(step: WriteStep, scope: Scope): Write {
  return isElementWrite(step) ? planElementWrite(step, scope) : planPageWrite(step, scope);
}

function fromAct(result: ActResult, attempts: number | undefined): StepOutcome {
  if (result.status === "done") return passed(attempts);
  const error = { code: result.code, message: result.message };
  // A dispatched write whose effect is unknown is never dispatched again: it stays indeterminate.
  const status = result.status === "unknown" ? "indeterminate" : "failed";
  return { status, error, ...(attempts && { attempts }) };
}

/** Waits for the element (reads may repeat), then dispatches the write exactly once. */
async function dispatch(
  write: Write,
  context: StepContext,
  attempts?: number,
): Promise<StepOutcome> {
  let reads = attempts;
  if (write.target && write.readiness) {
    const located = await locate(context.driver, write.target, write.readiness, context.deadline);
    if (!located.ok) return located.outcome;
    reads = located.attempts;
  }
  const left = remaining(context.deadline);
  if (left <= 0)
    return failed(
      "timeout",
      `No time was left to act within ${context.deadline.timeoutMs} ms.`,
      reads,
    );
  const acted = context.driver.act(write.command, { timeoutMs: left });
  try {
    return fromAct(await beforeDeadline(acted, context.deadline, "The write"), reads);
  } catch (error) {
    // Dispatched, so its effect is unknown: it is never dispatched again, even once it answers.
    const code = error instanceof StepFailure ? error.code : "adapter-error";
    const message = (error instanceof Error ? error.message : String(error)) || "Unknown error.";
    return { status: "indeterminate", error: { code, message }, ...(reads && { attempts: reads }) };
  }
}

/** Runs a write action: waits for its element, then dispatches it once. */
export function runWrite(step: WriteStep, context: StepContext): Promise<StepOutcome> {
  return dispatch(planWrite(step, context.scope), context);
}

/** Polls the replay's tabs until the query names exactly one, then switches to it once. */
export async function selectTab(
  step: ActionStep & { action: "selectTab" },
  context: StepContext,
): Promise<StepOutcome> {
  const query = typeof step.tab === "number" ? step.tab : interpolate(step.tab, context.scope);
  const poll = await pollUntil(
    () => context.driver.tabs(readTimeout(context.deadline)),
    (list) => matchTab(list, query) !== undefined,
    context.deadline,
  );
  if (!poll.met) {
    const outcome = unmet(poll, (list) => {
      const open = list.tabs.map(({ url, title }) => `${title} <${url}>`).join(", ") || "none";
      return failed(
        "timeout",
        `No single tab matched ${JSON.stringify(query)}; open tabs: ${open}.`,
      );
    });
    return { ...outcome, attempts: poll.attempts };
  }
  const index = matchTab(poll.value, query) ?? 0;
  return dispatch({ command: { kind: "selectTab", index } }, context, poll.attempts);
}

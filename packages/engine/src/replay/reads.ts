import type { ActionStep } from "@recnrun/protocol";
import type { ElementState } from "./driver.ts";
import { currentUrl, describeState, locate, unmet, urlMatches } from "./locate.ts";
import { failed, passed, quoted, type StepOutcome } from "./outcome.ts";
import { interpolate, interpolateTarget } from "./scope.ts";
import type { StepContext } from "./step-context.ts";
import { pollUntil, readTimeout } from "./wait.ts";

type WaitForStep = ActionStep & { action: "waitFor" };
type WaitState = NonNullable<WaitForStep["state"]>;

const WAIT_STATES: Readonly<Record<WaitState, (state: ElementState) => boolean>> = {
  visible: (state) => state.count === 1 && state.visible,
  hidden: (state) => state.count === 0 || (state.count === 1 && !state.visible),
  attached: (state) => state.count > 0,
  detached: (state) => state.count === 0,
};

const total = (...counts: number[]) => counts.reduce((sum, count) => sum + count, 0);

async function waitForElement(step: WaitForStep, context: StepContext): Promise<StepOutcome> {
  if (!step.target) return passed();
  const target = interpolateTarget(step.target, context.scope);
  const state = step.state ?? "visible";
  const poll = await pollUntil(
    () => context.driver.inspect(target, readTimeout(context.deadline)),
    WAIT_STATES[state],
    context.deadline,
  );
  if (poll.met) return passed(poll.attempts);
  const outcome = unmet(poll, (seen) =>
    failed("timeout", `${JSON.stringify(target)} was not ${state}: ${describeState(seen)}.`),
  );
  return { ...outcome, attempts: poll.attempts };
}

async function waitForUrl(step: WaitForStep, context: StepContext): Promise<StepOutcome> {
  if (step.url === undefined) return passed();
  const expected = interpolate(step.url, context.scope);
  const poll = await pollUntil(
    async () => currentUrl(await context.driver.tabs()),
    (url) => urlMatches(url, expected),
    context.deadline,
  );
  if (poll.met) return passed(poll.attempts);
  const outcome = unmet(poll, (url) =>
    failed("timeout", `The URL never matched ${JSON.stringify(expected)}; it is ${url}.`),
  );
  return { ...outcome, attempts: poll.attempts };
}

/** Waits for an element state, a URL, or both, under the step's one deadline. */
export async function waitFor(step: WaitForStep, context: StepContext): Promise<StepOutcome> {
  if (!step.target && step.url === undefined) {
    return failed("invalid-step", "waitFor needs a target, a url, or both.");
  }
  const element = await waitForElement(step, context);
  if (element.status !== "passed") return element;
  const url = await waitForUrl(step, context);
  const attempts = total(element.attempts ?? 0, url.attempts ?? 0);
  return { ...url, ...(attempts > 0 && { attempts }) };
}

/** Saves the target's text, whitespace collapsed, as `vars.<saveAs>`. */
export async function extractText(
  step: ActionStep & { action: "extractText" },
  context: StepContext,
): Promise<StepOutcome> {
  const target = interpolateTarget(step.target, context.scope);
  const located = await locate(context.driver, target, "attached", context.deadline);
  if (!located.ok) return located.outcome;
  const text = located.state.text.replace(/\s+/g, " ").trim();
  context.scope.vars[step.saveAs] = text;
  return passed(located.attempts, [quoted("observed", text)]);
}

/** Saves an attribute of the target as `vars.<saveAs>`, waiting until the element has it. */
export async function extractAttribute(
  step: ActionStep & { action: "extractAttribute" },
  context: StepContext,
): Promise<StepOutcome> {
  const target = interpolateTarget(step.target, context.scope);
  const located = await locate(context.driver, target, "attached", context.deadline);
  if (!located.ok) return located.outcome;
  const poll = await pollUntil(
    () => context.driver.readAttribute(target, step.attribute, readTimeout(context.deadline)),
    (value) => value !== null,
    context.deadline,
  );
  const attempts = located.attempts + poll.attempts;
  if (!poll.met) {
    const outcome = unmet(poll, () =>
      failed("timeout", `${JSON.stringify(target)} has no attribute ${step.attribute}.`),
    );
    return { ...outcome, attempts };
  }
  const value = poll.value ?? "";
  context.scope.vars[step.saveAs] = value;
  return passed(attempts, [quoted("observed", value)]);
}

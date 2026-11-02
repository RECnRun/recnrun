import type { AssertionStep } from "@recnrun/protocol";
import type { ElementState } from "./driver.ts";
import { containsText, currentUrl, describeState, sameText, unmet, urlMatches } from "./locate.ts";
import { passed, quoted, type StepOutcome } from "./outcome.ts";
import { interpolate, interpolateTarget } from "./scope.ts";
import type { StepContext } from "./step-context.ts";
import { pollUntil, readTimeout } from "./wait.ts";

/** One assertion: what to read, when it holds, and how to report both sides. */
interface Check<T> {
  read: () => Promise<T>;
  met: (value: T) => boolean;
  observed: (value: T) => string;
  expected: string;
}

type StateAssertion = "visible" | "hidden" | "enabled" | "disabled";

const one = (state: ElementState): boolean => state.count === 1;

const STATES: Readonly<Record<StateAssertion, (state: ElementState) => boolean>> = {
  visible: (state) => one(state) && state.visible,
  hidden: (state) => state.count === 0 || (one(state) && !state.visible),
  enabled: (state) => one(state) && state.enabled,
  disabled: (state) => one(state) && !state.enabled,
};

const observedText = (state: ElementState): string =>
  one(state) ? state.text : `(${describeState(state)})`;

const observedValue = (state: ElementState): string =>
  one(state) ? (state.value ?? "(no value)") : `(${describeState(state)})`;

function expectedMet(step: ElementAssertion & { expected: string }, expected: string) {
  if (step.assertion === "textEquals")
    return (state: ElementState) => sameText(state.text, expected);
  if (step.assertion === "textContains") {
    return (state: ElementState) => containsText(state.text, expected);
  }
  return (state: ElementState) => state.value === expected;
}

function urlCheck(expected: string, context: StepContext): Check<string> {
  return {
    read: async () => currentUrl(await context.driver.tabs()),
    met: (url) => urlMatches(url, expected),
    observed: (url) => url,
    expected,
  };
}

type ElementAssertion = Exclude<AssertionStep, { assertion: "url" }>;

function elementCheck(step: ElementAssertion, context: StepContext): Check<ElementState> {
  const target = interpolateTarget(step.target, context.scope);
  const read = () => context.driver.inspect(target, readTimeout(context.deadline));
  if (step.assertion === "count") {
    const expected = step.expected;
    const observed = (state: ElementState) => String(state.count);
    return { read, met: (state) => state.count === expected, observed, expected: String(expected) };
  }
  if (!("expected" in step)) {
    const met = STATES[step.assertion];
    return { read, met, observed: describeState, expected: step.assertion };
  }
  const expected = interpolate(step.expected, context.scope);
  const met = (state: ElementState) => one(state) && expectedMet(step, expected)(state);
  const observed = step.assertion === "value" ? observedValue : observedText;
  return { read, met, observed, expected };
}

async function check<T>(spec: Check<T>, context: StepContext): Promise<StepOutcome> {
  const poll = await pollUntil(spec.read, spec.met, context.deadline);
  if (poll.met) return passed(poll.attempts, [quoted("observed", spec.observed(poll.value))]);
  const outcome = unmet(poll, (value) => {
    const observed = spec.observed(value);
    return {
      status: "failed",
      error: {
        code: "assertion-failed",
        message: `Expected ${JSON.stringify(spec.expected)}, observed ${JSON.stringify(observed)}.`,
      },
      evidence: [quoted("expected", spec.expected), quoted("observed", observed)],
    };
  });
  return { ...outcome, attempts: poll.attempts };
}

/** Polls the assertion until it holds or the step's deadline passes; reading never acts. */
export function runAssertion(step: AssertionStep, context: StepContext): Promise<StepOutcome> {
  if (step.assertion === "url") {
    return check(urlCheck(interpolate(step.expected, context.scope), context), context);
  }
  return check(elementCheck(step, context), context);
}

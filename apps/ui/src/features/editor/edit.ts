import type { AssertionStep, Flow, Step, Target } from "@recnrun/protocol";

/** The assertions the editor offers in F2.6; F4.1 adds the rest. */
export const ASSERTION_KINDS = ["visible", "textEquals", "textContains", "value", "count"] as const;

export type AssertionKind = (typeof ASSERTION_KINDS)[number];

/** Strategies the assertion form accepts as one locator with a `value`. */
export const FORM_STRATEGIES = ["css", "testId", "text", "label"] as const;

export type FormStrategy = (typeof FORM_STRATEGIES)[number];

export const needsExpected = (kind: AssertionKind) => kind !== "visible";

export function removeStep(flow: Flow, stepId: string): Flow {
  return { ...flow, steps: flow.steps.filter((step) => step.id !== stepId) };
}

/** Sets or clears a step's own timeout; an empty field falls back to the engine default. */
export function setTimeoutMs(flow: Flow, stepId: string, timeoutMs: number | undefined): Flow {
  const steps = flow.steps.map((step): Step => {
    if (step.id !== stepId) return step;
    const { timeoutMs: _previous, ...rest } = step;
    return (timeoutMs === undefined ? rest : { ...rest, timeoutMs }) as Step;
  });
  return { ...flow, steps };
}

/** The first `assert-<n>` id no step of the flow uses. */
export function nextAssertionId(flow: Flow): string {
  const ids = new Set(flow.steps.map((step) => step.id));
  let index = 1;
  while (ids.has(`assert-${index}`)) index += 1;
  return `assert-${index}`;
}

/** The one-key locator F2.5 replay resolves; locator lists replay in F3. */
export function locatorFrom(strategy: FormStrategy, value: string): Target {
  if (strategy === "testId") return { testId: value };
  if (strategy === "text") return { text: value };
  if (strategy === "label") return { label: value };
  return { css: value };
}

/** An assertion step; `count` reads its expected value as a number, the save validates it. */
export function buildAssertion(
  id: string,
  kind: AssertionKind,
  target: Target,
  expected: string,
): AssertionStep {
  if (kind === "visible") return { id, assertion: kind, target };
  if (kind === "count") return { id, assertion: kind, target, expected: Number(expected) };
  return { id, assertion: kind, target, expected };
}

export function addStep(flow: Flow, step: Step): Flow {
  return { ...flow, steps: [...flow.steps, step] };
}

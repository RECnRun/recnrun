import {
  ASSERTION_NAMES,
  type AssertionStep,
  type Flow,
  type Step,
  type Target,
} from "@recnrun/protocol";

export const ASSERTION_KINDS = ASSERTION_NAMES;

export type AssertionKind = (typeof ASSERTION_KINDS)[number];

const PRESENCE_KINDS: readonly AssertionKind[] = ["visible", "hidden", "enabled", "disabled"];

export const needsExpected = (kind: AssertionKind) => !PRESENCE_KINDS.includes(kind);

/** `url` checks the page, not an element. */
export const needsTarget = (kind: AssertionKind) => kind !== "url";

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

/** What the assertion form collects; `target` is unset for `url` and while nothing is picked. */
export type AssertionDraft = { kind: AssertionKind; target: Target | undefined; expected: string };

/** An assertion step; `count` reads its expected value as a number, the save validates it. */
export function buildAssertion(id: string, draft: AssertionDraft): AssertionStep {
  const { kind, expected } = draft;
  if (kind === "url") return { id, assertion: kind, expected };
  // The forms offer "Add" only once a target exists, so no step is built without one.
  const target = draft.target ?? "";
  if (kind === "count") return { id, assertion: kind, target, expected: Number(expected) };
  if (!needsExpected(kind)) return { id, assertion: kind, target } as AssertionStep;
  return { id, assertion: kind, target, expected } as AssertionStep;
}

export function addStep(flow: Flow, step: Step): Flow {
  return { ...flow, steps: [...flow.steps, step] };
}

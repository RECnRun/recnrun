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

/** Replaces one field of a step; `undefined` removes it. */
export function setStepField(flow: Flow, stepId: string, key: string, value: unknown): Flow {
  const steps = flow.steps.map((step): Step => {
    if (step.id !== stepId) return step;
    const { [key]: _previous, ...rest } = step as Record<string, unknown>;
    return (value === undefined ? rest : { ...rest, [key]: value }) as Step;
  });
  return { ...flow, steps };
}

/** Sets or clears a step's own timeout; an empty field falls back to the engine default. */
export const setTimeoutMs = (flow: Flow, stepId: string, timeoutMs: number | undefined) =>
  setStepField(flow, stepId, "timeoutMs", timeoutMs);

/** The first `<prefix>-<n>` id no step of the flow uses. */
export function nextStepId(flow: Flow, prefix: string): string {
  const ids = new Set(flow.steps.map((step) => step.id));
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export const nextAssertionId = (flow: Flow) => nextStepId(flow, "assert");

/** Inserts the step before `before`, or at the end when that names no step. */
export function insertStep(flow: Flow, step: Step, before?: string): Flow {
  const at = flow.steps.findIndex((other) => other.id === before);
  const steps = [...flow.steps];
  steps.splice(at === -1 ? steps.length : at, 0, step);
  return { ...flow, steps };
}

/** Swaps the step with its neighbour; the first cannot move up, nor the last down. */
export function moveStep(flow: Flow, stepId: string, offset: -1 | 1): Flow {
  const from = flow.steps.findIndex((step) => step.id === stepId);
  const to = from + offset;
  if (from === -1 || to < 0 || to >= flow.steps.length) return flow;
  const steps = [...flow.steps];
  const [moved] = steps.splice(from, 1);
  if (moved) steps.splice(to, 0, moved);
  return { ...flow, steps };
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

/** The actions the step form adds by hand; the rest come from a recording. */
export const FORM_ACTIONS = ["navigate", "click", "fill", "keyPress", "waitFor"] as const;

export type FormAction = (typeof FORM_ACTIONS)[number];

export const WAIT_STATES = ["visible", "hidden", "attached", "detached"] as const;

export type WaitState = (typeof WAIT_STATES)[number];

/** What the step form collects; each action reads the fields it needs. */
export type ActionDraft = {
  action: FormAction;
  url: string;
  target: Target | undefined;
  value: string;
  key: string;
  state: WaitState;
};

export const EMPTY_ACTION: ActionDraft = {
  action: "navigate",
  url: "",
  target: undefined,
  value: "",
  key: "",
  state: "visible",
};

type Builder = (id: string, draft: ActionDraft) => Step | undefined;

const BUILDERS: Record<FormAction, Builder> = {
  navigate: (id, { url }) => (url ? { id, action: "navigate", url } : undefined),
  click: (id, { target }) => (target === undefined ? undefined : { id, action: "click", target }),
  fill: (id, { target, value }) =>
    target === undefined ? undefined : { id, action: "fill", target, value },
  keyPress: (id, { key, target }) =>
    key ? { id, action: "keyPress", key, ...(target !== undefined && { target }) } : undefined,
  // A wait needs an element or a URL; its state applies to the element only.
  waitFor: (id, { target, url, state }) =>
    target === undefined && !url
      ? undefined
      : {
          id,
          action: "waitFor",
          ...(target !== undefined && { target, state }),
          ...(url && { url }),
        },
};

/** The step the form's fields describe, or nothing while a required field is empty. */
export const buildAction = (id: string, draft: ActionDraft) => BUILDERS[draft.action](id, draft);

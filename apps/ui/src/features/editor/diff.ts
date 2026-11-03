import type { Flow } from "@recnrun/protocol";

export type FieldChange = "same" | "changed";

export type StepChange = FieldChange | "added" | "removed";

export type FlowDiff = {
  fields: { name: string; change: FieldChange }[];
  steps: { id: string; change: StepChange }[];
};

/** The parts of a flow besides its steps, in the order the comparison lists them. */
const FIELDS = [
  "name",
  "description",
  "actors",
  "inputs",
  "requirements",
  "preconditions",
] as const;

/** JSON with sorted keys and no undefined values, so two values differ only in content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const changeOf = (past: unknown, current: unknown): FieldChange =>
  canonical(past) === canonical(current) ? "same" : "changed";

/** What differs between a past revision and the flow as edited: each field, then each step by id. */
export function compareFlows(past: Flow, current: Flow): FlowDiff {
  const fields = FIELDS.map((name) => ({ name, change: changeOf(past[name], current[name]) }));
  const before = new Map(past.steps.map((step) => [step.id, step]));
  const steps: FlowDiff["steps"] = current.steps.map((step) => {
    const old = before.get(step.id);
    return { id: step.id, change: old === undefined ? "added" : changeOf(old, step) };
  });
  const kept = new Set(current.steps.map((step) => step.id));
  for (const step of past.steps) {
    if (!kept.has(step.id)) steps.push({ id: step.id, change: "removed" });
  }
  return { fields, steps };
}

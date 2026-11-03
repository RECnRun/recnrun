import type { Flow, INPUT_TYPES } from "./flow.ts";
import type { IssuePath } from "./flow-checks.ts";

type InputType = (typeof INPUT_TYPES)[number];

/** A value given for an input the flow does not declare, declares secret, or declares as another type. */
export interface InputValueIssue {
  code: "unknown-input" | "secret-input" | "input-type";
  name: string;
  message: string;
}

const HAS_TYPE: Readonly<Record<InputType, (value: unknown) => boolean>> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
};

// Names the kind of a value, never the value itself, so a message can carry no secret.
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return `${/^[aeiou]/.test(typeof value) ? "an" : "a"} ${typeof value}`;
}

/** The values a dataset or a run request gives that the flow's inputs do not accept. */
export function checkInputValues(flow: Flow, values: Record<string, unknown>): InputValueIssue[] {
  const issues: InputValueIssue[] = [];
  for (const [name, value] of Object.entries(values)) {
    const input = Object.hasOwn(flow.inputs, name) ? flow.inputs[name] : undefined;
    if (input === undefined) {
      issues.push({
        code: "unknown-input",
        name,
        message: `Input "${name}" is not declared in the flow.`,
      });
    } else if (input.secret) {
      const message = `Input "${name}" is secret: its value comes only from secrets, never from a dataset.`;
      issues.push({ code: "secret-input", name, message });
    } else if (!HAS_TYPE[input.type](value)) {
      const message = `Input "${name}" has type ${input.type}; the value given is ${kindOf(value)}.`;
      issues.push({ code: "input-type", name, message });
    }
  }
  return issues;
}

/** Inputs whose declared default is not of their declared type. */
export function findInputDefaultIssues(
  flow: Flow,
): { code: "input-default"; path: IssuePath; message: string }[] {
  return Object.entries(flow.inputs).flatMap(([name, input]) => {
    if (input.default === undefined || HAS_TYPE[input.type](input.default)) return [];
    const message = `Input "${name}" has type ${input.type}; its default is ${kindOf(input.default)}.`;
    return [{ code: "input-default" as const, path: ["inputs", name, "default"], message }];
  });
}

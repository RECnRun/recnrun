import { ACTION_NAMES, ASSERTION_NAMES } from "./actions.ts";
import type { Flow } from "./flow.ts";
import { parseInterpolations } from "./interpolation.ts";
import { BUILTIN_NAMES } from "./steps.ts";

export type IssuePath = (string | number)[];

type FlowCheckIssue = {
  code:
    | "unknown-action"
    | "unknown-assertion"
    | "unknown-builtin"
    | "duplicate-step-id"
    | "missing-input"
    | "cyclic-variable";
  path: IssuePath;
  message: string;
};

type StepRecord = Record<string, unknown>;

// Keys under which a control block nests its steps; their contents are walked as steps.
const CHILD_STEP_KEYS = ["steps", "then", "else"];

function isRecord(value: unknown): value is StepRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Visits every step, nested ones included, in document order; works on unvalidated input. */
function walkSteps(
  steps: unknown,
  path: IssuePath,
  visit: (step: StepRecord, path: IssuePath) => void,
): void {
  if (!Array.isArray(steps)) return;
  steps.forEach((step: unknown, index) => {
    if (!isRecord(step)) return;
    const stepPath = [...path, index];
    visit(step, stepPath);
    for (const key of CHILD_STEP_KEYS) walkSteps(step[key], [...stepPath, key], visit);
  });
}

const KINDS = [
  ["action", ACTION_NAMES, "unknown-action"],
  ["assertion", ASSERTION_NAMES, "unknown-assertion"],
  ["builtin", BUILTIN_NAMES, "unknown-builtin"],
] as const;

/** Steps whose `action`, `assertion`, or `builtin` names nothing the engine has. */
export function findUnknownStepKinds(input: unknown): FlowCheckIssue[] {
  const issues: FlowCheckIssue[] = [];
  const steps = isRecord(input) ? input["steps"] : undefined;
  walkSteps(steps, ["steps"], (step, path) => {
    for (const [key, names, code] of KINDS) {
      const name = step[key];
      if (typeof name === "string" && !(names as readonly string[]).includes(name)) {
        issues.push({ code, path: [...path, key], message: `Unknown ${key} "${name}".` });
      }
    }
  });
  return issues;
}

function collectStrings(value: unknown, path: IssuePath, out: [string, IssuePath][]): void {
  if (typeof value === "string") out.push([value, path]);
  else if (Array.isArray(value))
    value.forEach((item, i) => collectStrings(item, [...path, i], out));
  else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) collectStrings(item, [...path, key], out);
  }
}

/** The strings a step itself holds, without those of the steps it nests. */
function ownStrings(step: StepRecord, path: IssuePath): [string, IssuePath][] {
  const out: [string, IssuePath][] = [];
  for (const [key, value] of Object.entries(step)) {
    if (!CHILD_STEP_KEYS.includes(key)) collectStrings(value, [...path, key], out);
  }
  return out;
}

function references(step: StepRecord, path: IssuePath, namespace: string) {
  return ownStrings(step, path).flatMap(([text, at]) =>
    parseInterpolations(text)
      .filter((reference) => reference.namespace === namespace)
      .map((reference) => ({ name: reference.path[0] ?? "", path: at })),
  );
}

export function findDuplicateStepIds(flow: Flow): FlowCheckIssue[] {
  const seen = new Set<unknown>();
  const issues: FlowCheckIssue[] = [];
  walkSteps(flow.steps, ["steps"], (step, path) => {
    if (seen.has(step["id"])) {
      issues.push({
        code: "duplicate-step-id",
        path: [...path, "id"],
        message: `Step id "${String(step["id"])}" is already used.`,
      });
    }
    seen.add(step["id"]);
  });
  return issues;
}

export function findMissingInputs(flow: Flow): FlowCheckIssue[] {
  const issues: FlowCheckIssue[] = [];
  walkSteps(flow.steps, ["steps"], (step, path) => {
    for (const reference of references(step, path, "inputs")) {
      if (!Object.hasOwn(flow.inputs, reference.name)) {
        issues.push({
          code: "missing-input",
          path: reference.path,
          message: `Input "${reference.name}" is not declared in inputs.`,
        });
      }
    }
  });
  return issues;
}

/** The variable a step defines: an extraction's or a call's `saveAs`, or `setVariable`'s `name`. */
function definedVariable(step: StepRecord): unknown {
  return step["builtin"] === "setVariable" ? step["name"] : step["saveAs"];
}

type Definition = { path: IssuePath; uses: Set<string> };

function variableGraph(flow: Flow): Map<string, Definition> {
  const graph = new Map<string, Definition>();
  walkSteps(flow.steps, ["steps"], (step, path) => {
    const name = definedVariable(step);
    if (typeof name !== "string") return;
    const definition = graph.get(name) ?? { path, uses: new Set<string>() };
    for (const reference of references(step, path, "vars")) definition.uses.add(reference.name);
    graph.set(name, definition);
  });
  return graph;
}

/** Variables defined, directly or through others, from themselves. */
export function findCyclicVariables(flow: Flow): FlowCheckIssue[] {
  const graph = variableGraph(flow);
  const done = new Set<string>();
  const issues: FlowCheckIssue[] = [];
  const visit = (name: string, trail: string[]): void => {
    if (done.has(name)) return;
    if (trail.includes(name)) {
      const cycle = [...trail.slice(trail.indexOf(name)), name].join(" -> ");
      const path = graph.get(name)?.path ?? [];
      issues.push({ code: "cyclic-variable", path, message: `Variables form a cycle: ${cycle}.` });
      return;
    }
    for (const use of graph.get(name)?.uses ?? []) visit(use, [...trail, name]);
    done.add(name);
  };
  for (const name of graph.keys()) visit(name, []);
  return issues;
}

import { parseInterpolations, type Flow, type Target } from "@recnrun/protocol";
import { StepFailure } from "./outcome.ts";

type Values = Record<string, string>;

/** What `${...}` can read during one run; `vars` grows as extractions save values. */
export interface Scope {
  readonly env: Values;
  readonly inputs: Values;
  readonly vars: Values;
  readonly secrets: Values;
}

export interface ScopeOptions {
  env?: Record<string, string> | undefined;
  /** Input values, such as a dataset's `inputs`; secret inputs are never read from here. */
  inputs?: Record<string, unknown> | undefined;
  /** Secrets provided locally for this run only; they are never stored and are redacted. */
  secrets?: Record<string, string> | undefined;
}

const REDACTED = "[redacted]";
const NAMESPACES = ["env", "inputs", "vars", "secrets"] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Builds the scope, or names the first required input that has no value. */
export function createScope(flow: Flow, options: ScopeOptions): Scope | { missing: string } {
  const given = options.inputs ?? {};
  const secrets = options.secrets ?? {};
  const inputs: Values = {};
  for (const [name, value] of Object.entries(given)) inputs[name] = text(value);
  for (const [name, input] of Object.entries(flow.inputs)) {
    const source: Record<string, unknown> = input.secret ? secrets : given;
    const value = Object.hasOwn(source, name) ? source[name] : input.default;
    if (value !== undefined) inputs[name] = text(value);
    else if (input.required) return { missing: name };
    else delete inputs[name];
  }
  return { env: options.env ?? {}, inputs, vars: {}, secrets: { ...secrets } };
}

/** The values that must never leave the executor: every secret and every secret input. */
export function secretValues(flow: Flow, scope: Scope): string[] {
  const secretInputs = Object.entries(flow.inputs).flatMap(([name, input]) =>
    input.secret && Object.hasOwn(scope.inputs, name) ? [scope.inputs[name] ?? ""] : [],
  );
  const values = [...Object.values(scope.secrets), ...secretInputs].filter(Boolean);
  // Longest first, so a secret that contains another is replaced whole.
  return [...new Set(values)].toSorted((a, b) => b.length - a.length);
}

/** Replaces every secret value in `text`. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join(REDACTED), text);
}

function lookup(scope: Scope, namespace: string, path: string[]): string | undefined {
  if (!(NAMESPACES as readonly string[]).includes(namespace)) return undefined;
  const values = scope[namespace as (typeof NAMESPACES)[number]];
  const [name = "", ...rest] = path;
  if (rest.length > 0 || !Object.hasOwn(values, name)) return undefined;
  return values[name];
}

/** Resolves `${env|inputs|vars|secrets.<name>}`; `locals` and unknown names fail the step. */
export function interpolate(source: string, scope: Scope): string {
  let resolved = "";
  let from = 0;
  for (const { raw, namespace, path, start } of parseInterpolations(source)) {
    const value = lookup(scope, namespace, path);
    if (value === undefined) {
      throw new StepFailure("unresolved-variable", `${raw} has no value in this run.`);
    }
    resolved += source.slice(from, start) + value;
    from = start + raw.length;
  }
  return resolved + source.slice(from);
}

function interpolateValue(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") return interpolate(value, scope);
  if (Array.isArray(value)) return value.map((item: unknown) => interpolateValue(item, scope));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, interpolateValue(item, scope)]),
  );
}

/** Resolves every string of a target, nested locators included. */
export function interpolateTarget(target: Target, scope: Scope): Target {
  return interpolateValue(target, scope) as Target;
}

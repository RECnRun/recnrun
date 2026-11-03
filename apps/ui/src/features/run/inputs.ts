import { type Flow, parseInterpolations } from "@recnrun/protocol";

export type Input = Flow["inputs"][string];

/** What the user typed per input: text for most types, a flag for booleans. */
export type Draft = Record<string, string | boolean>;

/** What `flow.replay` sends: secrets travel apart from inputs, for this run only. */
export type RunValues = { inputs: Record<string, unknown>; secrets: Record<string, string> };

export type Parsed = ({ ok: true } & RunValues) | { ok: false; message: string };

/** A `${secrets.<name>}` reference is a required secret field keyed apart from the inputs. */
export const referenceKey = (name: string) => `secrets.${name}`;

/** The `${secrets.<name>}` names the flow reads that no secret input already provides. */
export function secretReferences(flow: Flow): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const { namespace, path } of parseInterpolations(value))
        if (namespace === "secrets" && path[0]) names.add(path[0]);
    } else if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
  };
  visit(flow);
  return [...names].filter((name) => flow.inputs[name]?.secret !== true).toSorted();
}

/** The form's starting values: each input's default, never a secret's. */
export function initialDraft(inputs: Flow["inputs"], references: string[] = []): Draft {
  const draft: Draft = {};
  for (const [name, input] of Object.entries(inputs)) {
    if (input.type === "boolean") draft[name] = input.default === true;
    else if (input.secret || input.default === undefined) draft[name] = "";
    else
      draft[name] =
        typeof input.default === "string" ? input.default : JSON.stringify(input.default);
  }
  for (const name of references) draft[referenceKey(name)] = "";
  return draft;
}

function parseText(name: string, input: Input, text: string): unknown {
  if (input.type === "string") return text;
  if (input.type === "number") {
    const value = Number(text);
    if (Number.isNaN(value)) throw new Error(`${name} must be a number.`);
    return value;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${name} must be JSON (${input.type}).`);
  }
}

function requireValue(name: string, input: Input) {
  if (input.required && input.default === undefined) throw new Error(`${name} is required.`);
}

function parseInput(name: string, input: Input, raw: string | boolean, values: RunValues) {
  if (input.secret) {
    if (raw !== "") values.secrets[name] = String(raw);
    else requireValue(name, input);
  } else if (typeof raw === "boolean") values.inputs[name] = raw;
  else if (raw !== "") values.inputs[name] = parseText(name, input, raw);
  else requireValue(name, input);
}

/** Turns the form into `flow.replay` inputs and secrets; an empty optional field is left to the flow's default. */
export function parseDraft(
  inputs: Flow["inputs"],
  draft: Draft,
  references: string[] = [],
): Parsed {
  const values: RunValues = { inputs: {}, secrets: {} };
  try {
    for (const [name, input] of Object.entries(inputs))
      parseInput(name, input, draft[name] ?? "", values);
    for (const name of references) {
      const raw = draft[referenceKey(name)];
      if (typeof raw !== "string" || raw === "")
        throw new Error(`${referenceKey(name)} is required.`);
      values.secrets[name] = raw;
    }
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  return { ok: true, ...values };
}

/** The draft with every secret emptied, so a secret never stays on screen after a run starts. */
export function withoutSecrets(
  inputs: Flow["inputs"],
  draft: Draft,
  references: string[] = [],
): Draft {
  const next = { ...draft };
  for (const [name, input] of Object.entries(inputs)) if (input.secret) next[name] = "";
  for (const name of references) next[referenceKey(name)] = "";
  return next;
}

/** The form filled from a dataset: its values, the input's default where it has none; secrets stay as typed. */
export function datasetDraft(
  inputs: Flow["inputs"],
  values: Record<string, unknown>,
  draft: Draft,
): Draft {
  const defaults = initialDraft(inputs);
  const next = { ...draft };
  for (const [name, input] of Object.entries(inputs)) {
    if (input.secret) continue;
    const value = values[name];
    if (value === undefined) next[name] = defaults[name] ?? "";
    else if (typeof value === "boolean" || typeof value === "string") next[name] = value;
    else next[name] = JSON.stringify(value);
  }
  return next;
}

/** The non-secret inputs as typed, for `dataset.save`: a secret never goes into a dataset. */
export function datasetInputs(inputs: Flow["inputs"], draft: Draft): Parsed {
  const open = Object.entries(inputs).filter(([, input]) => !input.secret);
  return parseDraft(Object.fromEntries(open), draft);
}

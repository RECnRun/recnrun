import type { Flow } from "@recnrun/protocol";

export type Input = Flow["inputs"][string];

/** What the user typed per input: text for most types, a flag for booleans. */
export type Draft = Record<string, string | boolean>;

export type Parsed = { ok: true; inputs: Record<string, unknown> } | { ok: false; message: string };

/** The form's starting values: each input's default, never a secret's. */
export function initialDraft(inputs: Flow["inputs"]): Draft {
  const draft: Draft = {};
  for (const [name, input] of Object.entries(inputs)) {
    if (input.type === "boolean") draft[name] = input.default === true;
    else if (input.secret || input.default === undefined) draft[name] = "";
    else
      draft[name] =
        typeof input.default === "string" ? input.default : JSON.stringify(input.default);
  }
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

/** Turns the form into `flow.replay` inputs; an empty optional field is left to the flow's default. */
export function parseDraft(inputs: Flow["inputs"], draft: Draft): Parsed {
  const parsed: Record<string, unknown> = {};
  try {
    for (const [name, input] of Object.entries(inputs)) {
      const raw = draft[name] ?? "";
      if (typeof raw === "boolean") parsed[name] = raw;
      else if (raw !== "") parsed[name] = parseText(name, input, raw);
      else if (input.required && input.default === undefined)
        throw new Error(`${name} is required.`);
    }
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  return { ok: true, inputs: parsed };
}

/** The draft with every secret emptied, so a secret never stays on screen after a run starts. */
export function withoutSecrets(inputs: Flow["inputs"], draft: Draft): Draft {
  const next = { ...draft };
  for (const [name, input] of Object.entries(inputs)) if (input.secret) next[name] = "";
  return next;
}

import { shortcutOf } from "./keys.ts";
import { keyOf, type DomEvent, type DomTarget, type Draft } from "./types.ts";

/** A stretch of the run: typed text, or one special key or shortcut (`combo`). */
interface Token {
  combo?: string;
  text: string;
  typed: boolean;
  events: DomEvent[];
}

/** The editing of one field, from its first key or input until blur, change, submit, or navigation. */
export interface FieldRun {
  key: string;
  target: DomTarget;
  tokens: Token[];
  redacted: boolean;
  /** The page changed the value beyond the typed text (autocomplete, masks). */
  transformed: boolean;
  composing: boolean;
  /** The value the typed data alone would produce. */
  model: string;
  value?: string;
}

const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox"]);

export const isToggle = (target: DomTarget): boolean =>
  target.tag === "input" && (target.inputType === "checkbox" || target.inputType === "radio");

export function isTextField(target: DomTarget): boolean {
  if (target.tag === "textarea") return true;
  if (target.tag === "input") return !NON_TEXT_INPUTS.has(target.inputType ?? "text");
  return TEXT_ROLES.has(target.role ?? "");
}

export const openRun = (event: DomEvent): FieldRun => ({
  key: keyOf(event),
  target: event.payload.target,
  tokens: [],
  redacted: false,
  transformed: false,
  composing: false,
  model: "",
});

function textToken(run: FieldRun): Token {
  const last = run.tokens.at(-1);
  if (last && last.combo === undefined) return last;
  const token: Token = { text: "", typed: false, events: [] };
  run.tokens.push(token);
  return token;
}

function compare(run: FieldRun): void {
  if (!run.composing && run.value !== undefined && run.value !== run.model) run.transformed = true;
}

function feedInput(run: FieldRun, event: DomEvent): void {
  const token = textToken(run);
  const { inputType, value } = event.payload;
  const data = typeof event.payload.data === "string" ? event.payload.data : "";
  token.events.push(event);
  token.typed = true;
  if (value !== undefined) run.value = value;
  if (inputType === "insertText") {
    token.text += data;
    run.model += data;
  } else if (inputType === "deleteContentBackward") {
    token.text = token.text.slice(0, -1);
    run.model = value ?? run.model.slice(0, -1);
  } else if (inputType !== "insertCompositionText") {
    // Paste, drop, and word deletion: the reported value is the truth.
    token.text += data;
    run.model = value ?? run.model + data;
  }
  compare(run);
}

function feedCompositionEnd(run: FieldRun, event: DomEvent): void {
  const token = textToken(run);
  const data = event.payload.data ?? "";
  token.events.push(event);
  token.typed = true;
  token.text += data;
  run.model += data;
  run.composing = false;
  compare(run);
}

function feedChange(run: FieldRun, event: DomEvent): void {
  const { value } = event.payload;
  if (value !== undefined) run.value = value;
  const typed = run.tokens.findLast((candidate) => candidate.typed);
  if (typed) return void typed.events.push(event);
  // A change with no input before it (a native select, autofill) still sets the value.
  const token = textToken(run);
  token.events.push(event);
  token.typed = value !== undefined;
  run.model = value ?? run.model;
}

function feedKey(run: FieldRun, event: DomEvent): void {
  const combo = shortcutOf(event.payload);
  if (combo === undefined) textToken(run).events.push(event);
  else run.tokens.push({ combo, text: "", typed: false, events: [event] });
}

export function feedRun(run: FieldRun, event: DomEvent): void {
  if (event.payload.redacted) run.redacted = true;
  if (event.type === "keydown") return feedKey(run, event);
  if (event.type === "input") return feedInput(run, event);
  if (event.type === "change") return feedChange(run, event);
  if (event.type === "compositionend") return feedCompositionEnd(run, event);
  if (event.type === "compositionstart") run.composing = true;
  (run.tokens.at(-1) ?? textToken(run)).events.push(event);
}

const identifier = (text: string) => text.replaceAll(/\W/g, "_").replace(/^(?=\d)/, "_");

/** A redacted value is never known: the step reads it from the local secrets store instead. */
function placeholder(target: DomTarget): string {
  return `\${secrets.${identifier(target.name ?? target.id ?? target.testId ?? "secret")}}`;
}

function fieldDraft(run: FieldRun, value: string, events: DomEvent[]): Draft {
  const action = run.target.tag === "select" ? "select" : "fill";
  return { action, target: run.target, value, events, ...(run.redacted ? { redacted: true } : {}) };
}

/** Turns tokens into drafts; a token that yields none hands its events to a neighbor. */
function emitTokens(
  run: FieldRun,
  tokens: Token[],
  asText: (token: Token) => Draft | undefined,
  drafts: Draft[] = [],
): Draft[] {
  let orphans: DomEvent[] = [];
  for (const token of tokens) {
    const draft =
      token.combo === undefined
        ? asText(token)
        : {
            action: "keyPress" as const,
            key: token.combo,
            target: run.target,
            events: token.events,
          };
    const last = drafts.at(-1);
    if (draft) {
      draft.events = [...orphans, ...draft.events];
      orphans = [];
      drafts.push(draft);
    } else if (last) last.events.push(...token.events);
    else orphans.push(...token.events);
  }
  return drafts;
}

const typeDraft = (run: FieldRun, token: Token): Draft | undefined =>
  token.text === ""
    ? undefined
    : { action: "type", target: run.target, value: token.text, events: token.events };

/** Fill when the typed text alone explains the value; type and keyPress when keys mattered. */
export function closeRun(run: FieldRun): Draft[] {
  if (run.redacted) {
    return [
      fieldDraft(
        run,
        placeholder(run.target),
        run.tokens.flatMap((token) => token.events),
      ),
    ];
  }
  const lastTyped = run.tokens.findLastIndex((token) => token.typed);
  const head = run.tokens.slice(0, lastTyped + 1);
  const tail = run.tokens.slice(lastTyped + 1);
  const none = () => undefined;
  if (lastTyped < 0) return emitTokens(run, tail, none);
  const perKey = run.transformed || head.some((token) => token.combo !== undefined);
  const drafts = perKey
    ? emitTokens(run, head, (token) => typeDraft(run, token))
    : [
        fieldDraft(
          run,
          run.value ?? run.model,
          head.flatMap((token) => token.events),
        ),
      ];
  return emitTokens(run, tail, none, drafts);
}

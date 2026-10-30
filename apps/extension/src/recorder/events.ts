import type { StepAuthor, StepDraft } from "@recnrun/domain";
import { selectorFor } from "./selector.ts";

export interface RecorderOptions {
  now: () => Date;
  url: () => string;
  /** How long typing may pause before the field's value becomes one `fill` step. */
  debounceMs: number;
}

export interface EventRecorder {
  /** Listens on the document; returns a function that stops listening. */
  attach(target: Document): () => void;
}

type Emit = (command: string, target: EventTarget | null, by: StepAuthor, value?: string) => void;
type Field = HTMLInputElement | HTMLTextAreaElement;

const INTERACTIVE = "button, a, input, select, textarea, label, summary, [role], [data-testid]";
const PRESS_KEYS = new Set(["Enter", "Escape", "Tab"]);
const MASK = "***";

function isField(target: EventTarget | null): target is Field {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function author(event: Event): StepAuthor {
  return event.isTrusted ? "user" : "page";
}

function fieldValue(field: Field): string {
  return field instanceof HTMLInputElement && field.type === "password" ? MASK : field.value;
}

function createEmitter(report: (step: StepDraft) => void, options: RecorderOptions): Emit {
  return (command, target, by, value) => {
    const element = target instanceof Element ? target : null;
    report({
      recordedAt: options.now().toISOString(),
      url: options.url(),
      author: by,
      command,
      ...(element ? { selector: selectorFor(element) } : {}),
      ...(value === undefined ? {} : { value }),
    });
  };
}

/** Typing becomes one `fill` (or `clear`) per field once it pauses or another step follows. */
function createPendingFields(emit: Emit, debounceMs: number) {
  const pending = new Map<Field, { timer: ReturnType<typeof setTimeout>; author: StepAuthor }>();
  const flush = (field: Field): void => {
    const entry = pending.get(field);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(field);
    const value = fieldValue(field);
    if (value === "") emit("clear", field, entry.author);
    else emit("fill", field, entry.author, value);
  };
  return {
    schedule(field: Field, by: StepAuthor): void {
      const previous = pending.get(field);
      if (previous) clearTimeout(previous.timer);
      pending.set(field, { author: by, timer: setTimeout(() => flush(field), debounceMs) });
    },
    flushAll(): void {
      for (const field of pending.keys()) flush(field);
    },
    clear(): void {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    },
  };
}

/** Turns DOM events into step drafts. Pure apart from timers, so Browser Mode tests cover it. */
export function createEventRecorder(
  report: (step: StepDraft) => void,
  options: RecorderOptions,
): EventRecorder {
  const emit = createEmitter(report, options);
  const fields = createPendingFields(emit, options.debounceMs);

  const listeners: [string, (event: Event) => void][] = [
    [
      "click",
      (event) => {
        fields.flushAll();
        const target = event.target instanceof Element ? event.target : null;
        emit("click", target?.closest(INTERACTIVE) ?? target, author(event));
      },
    ],
    [
      "input",
      (event) => {
        if (isField(event.target)) fields.schedule(event.target, author(event));
      },
    ],
    [
      "change",
      (event) => {
        if (!(event.target instanceof HTMLSelectElement)) return;
        fields.flushAll();
        emit("select", event.target, author(event), event.target.value);
      },
    ],
    [
      "keydown",
      (event) => {
        if (!(event instanceof KeyboardEvent) || !PRESS_KEYS.has(event.key)) return;
        fields.flushAll();
        emit("press", event.target, author(event), event.key);
      },
    ],
  ];

  return {
    attach(target) {
      for (const [type, listener] of listeners) target.addEventListener(type, listener, true);
      return () => {
        for (const [type, listener] of listeners) target.removeEventListener(type, listener, true);
        fields.clear();
      };
    },
  };
}

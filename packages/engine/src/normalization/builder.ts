import type { CapturedEvent, DomEventType } from "@recnrun/protocol";
import { feedRun, isTextField, isToggle, openRun, type FieldRun } from "./fields.ts";
import { pressedKey } from "./keys.ts";
import { onNavigation } from "./navigation.ts";
import { onClick, onDblclick, onPointerDown, onPointerUp } from "./pointer.ts";
import { onScroll } from "./scroll.ts";
import { attachToTarget, flushRun, lastDraft, type State } from "./state.ts";
import {
  elementTarget,
  endOf,
  isDomEvent,
  keyOf,
  timeOf,
  type DomEvent,
  type Settings,
} from "./types.ts";

type Handler = (state: State, event: DomEvent) => void;

const openRunOf = (state: State, event: DomEvent): FieldRun | undefined =>
  state.run?.key === keyOf(event) ? state.run : undefined;

function startRun(state: State, event: DomEvent): FieldRun {
  flushRun(state);
  state.run = openRun(event);
  return state.run;
}

function onKeydown(state: State, event: DomEvent): void {
  const run = openRunOf(state, event);
  if (run) return feedRun(run, event);
  if (isTextField(event.payload.target)) return feedRun(startRun(state, event), event);
  flushRun(state);
  const key = pressedKey(event.payload);
  if (key === undefined) return;
  const target = elementTarget(event.payload.target);
  const targetKey = keyOf(event);
  state.drafts.push({
    action: "keyPress",
    key,
    events: [event],
    targetKey,
    ...(target && { target }),
  });
}

function onKeyup(state: State, event: DomEvent): void {
  const run = openRunOf(state, event);
  if (run) return feedRun(run, event);
  const last = lastDraft(state);
  const down = last?.events[0];
  if (last?.action !== "keyPress" || !down || !isDomEvent(down)) return;
  if (down.payload.key === event.payload.key) last.events.push(event);
}

/** Input and composition events edit a field; a checkbox's join the click that toggled it. */
function onEdit(state: State, event: DomEvent): void {
  if (isToggle(event.payload.target)) return attachToTarget(state, event);
  feedRun(openRunOf(state, event) ?? startRun(state, event), event);
}

function onChange(state: State, event: DomEvent): void {
  const run = openRunOf(state, event);
  if (run || event.payload.target.tag === "select") {
    feedRun(run ?? startRun(state, event), event);
    return flushRun(state);
  }
  // A change after the run ended (focus already moved) joins the field's step.
  attachToTarget(state, event);
}

function onFocusOut(state: State, event: DomEvent): void {
  if (openRunOf(state, event)) flushRun(state);
}

function onSubmit(state: State, event: DomEvent): void {
  flushRun(state);
  state.submittedAt = timeOf(event);
  const last = lastDraft(state);
  if (last && timeOf(event) - endOf(last) <= state.settings.navigationWindowMs) {
    last.events.push(event);
  }
}

const HANDLERS: Partial<Record<DomEventType, Handler>> = {
  pointerdown: onPointerDown,
  pointerup: onPointerUp,
  click: onClick,
  dblclick: onDblclick,
  keydown: onKeydown,
  keyup: onKeyup,
  input: onEdit,
  compositionstart: onEdit,
  compositionupdate: onEdit,
  compositionend: onEdit,
  change: onChange,
  focusout: onFocusOut,
  submit: onSubmit,
  scroll: onScroll,
};

/** One pass over the kept events in time order, building step drafts. */
export function buildDrafts(events: CapturedEvent[], settings: Settings): State {
  const state: State = { settings, drafts: [], excluded: [], requests: [] };
  for (const event of events) {
    if (isDomEvent(event)) HANDLERS[event.type]?.(state, event);
    else if (event.category === "navigation") onNavigation(state, event);
    else if (event.category === "network" && event.type === "request") {
      state.requests.push(timeOf(event));
    }
  }
  flushRun(state);
  return state;
}

import { flushRunUnless, lastDraft, type State } from "./state.ts";
import { endOf, keyOf, timeOf, type DomEvent, type Draft } from "./types.ts";

const within = (state: State, draft: Draft, event: DomEvent) =>
  timeOf(event) - endOf(draft) <= state.settings.dblclickWindowMs;

export function onPointerDown(state: State, event: DomEvent): void {
  flushRunUnless(state, event);
  state.down = event;
  state.up = undefined;
  state.dragged = undefined;
}

/** The pointer is released over another target than it was pressed on: a drag. */
export function onPointerUp(state: State, event: DomEvent): void {
  const { down } = state;
  if (!down || keyOf(down) === keyOf(event)) {
    state.up = event;
    return;
  }
  const drag: Draft = {
    action: "drag",
    target: down.payload.target,
    to: event.payload.target,
    events: [down, event],
    targetKey: keyOf(down),
  };
  state.drafts.push(drag);
  state.dragged = drag;
  state.down = undefined;
}

/** The pointerdown and pointerup that preceded a click on the same target. */
function gesture(state: State, event: DomEvent): DomEvent[] {
  const key = keyOf(event);
  const events = [state.down, state.up].filter(
    (candidate): candidate is DomEvent => candidate !== undefined && keyOf(candidate) === key,
  );
  state.down = undefined;
  state.up = undefined;
  return events;
}

// The browser numbers clicks in `detail`; a second click it did not count is not a double click.
function isSecondClick(state: State, last: Draft, event: DomEvent): boolean {
  const { detail } = event.payload;
  return (
    last.targetKey === keyOf(event) &&
    within(state, last, event) &&
    (detail === undefined || detail >= 2)
  );
}

// A click with detail 0 is the activation that Enter or Space fired, already a keyPress.
function isKeyActivation(state: State, last: Draft | undefined, event: DomEvent): boolean {
  if (event.payload.detail !== 0 || last?.action !== "keyPress") return false;
  return (last.key === "Enter" || last.key === " ") && within(state, last, event);
}

export function onClick(state: State, event: DomEvent): void {
  const { dragged } = state;
  state.dragged = undefined;
  // The click a browser fires on the common ancestor after a drag belongs to the drag.
  if (dragged && within(state, dragged, event)) {
    dragged.events.push(event);
    return;
  }
  flushRunUnless(state, event);
  const events = [...gesture(state, event), event];
  const last = lastDraft(state);
  if (last?.action === "click" && isSecondClick(state, last, event)) {
    last.action = "dblclick";
    last.events.push(...events);
  } else if (isKeyActivation(state, last, event)) {
    last?.events.push(...events);
  } else {
    const target = event.payload.target;
    state.drafts.push({ action: "click", target, events, targetKey: keyOf(event) });
  }
}

export function onDblclick(state: State, event: DomEvent): void {
  const last = lastDraft(state);
  const key = keyOf(event);
  if ((last?.action === "click" || last?.action === "dblclick") && last.targetKey === key) {
    last.action = "dblclick";
    last.events.push(event);
    return;
  }
  const events = [...gesture(state, event), event];
  state.drafts.push({ action: "dblclick", target: event.payload.target, events, targetKey: key });
}

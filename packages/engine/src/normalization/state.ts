import type { ExcludedEvent } from "@recnrun/protocol";
import { closeRun, type FieldRun } from "./fields.ts";
import { keyOf, type DomEvent, type Draft, type Settings } from "./types.ts";

/** What the single pass over the events carries from one event to the next. */
export interface State {
  settings: Settings;
  drafts: Draft[];
  excluded: ExcludedEvent[];
  /** Times of network requests, for the scroll policy. */
  requests: number[];
  run?: FieldRun | undefined;
  /** The pointer events of the gesture in progress. */
  down?: DomEvent | undefined;
  up?: DomEvent | undefined;
  /** The drag that absorbs the click the browser fires after it. */
  dragged?: Draft | undefined;
  submittedAt?: number | undefined;
}

export const lastDraft = (state: State): Draft | undefined => state.drafts.at(-1);

export function flushRun(state: State): void {
  const { run } = state;
  if (!run) return;
  state.run = undefined;
  for (const draft of closeRun(run)) state.drafts.push({ ...draft, targetKey: run.key });
}

/** An interaction elsewhere ends the field's editing. */
export function flushRunUnless(state: State, event: DomEvent): void {
  if (state.run?.key !== keyOf(event)) flushRun(state);
}

/** Joins an event that adds nothing new (a late change, a checkbox's input) to its target's step. */
export function attachToTarget(state: State, event: DomEvent): void {
  const key = keyOf(event);
  state.drafts.findLast((draft) => draft.targetKey === key)?.events.push(event);
}

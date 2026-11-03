import { flushRun, type State } from "./state.ts";
import { endOf, refOf, timeOf, type DomTarget, type Draft, type NavigationEvent } from "./types.ts";

const isMainFrame = (event: NavigationEvent) =>
  !(event.type === "committed" && event.payload.parentFrameId) &&
  (event.frameId === null || event.targetId === null || event.frameId === event.targetId);

const isLink = (target: DomTarget) => target.tag === "a" || target.role === "link";

function isSubmit(target: DomTarget): boolean {
  if (target.tag === "button")
    return target.inputType === undefined || target.inputType === "submit";
  return target.tag === "input" && (target.inputType === "submit" || target.inputType === "image");
}

/** Steps whose replay navigates by itself: a link or submit click, Enter, or a navigate (redirects). */
function navigates(draft: Draft): boolean {
  if (draft.action === "keyPress") return draft.key === "Enter";
  if (draft.action === "click" || draft.action === "dblclick") {
    return isLink(draft.target) || isSubmit(draft.target);
  }
  return draft.action === "navigate";
}

function isCaused(state: State, at: number): boolean {
  const recent = (time: number) => at - time <= state.settings.navigationWindowMs;
  const cause = state.drafts.findLast((draft) => draft.action !== "scroll");
  if (cause && navigates(cause) && recent(endOf(cause))) return true;
  return state.submittedAt !== undefined && recent(state.submittedAt);
}

/** A navigation becomes a navigate step only when no recent step already causes it on replay. */
export function onNavigation(state: State, event: NavigationEvent): void {
  if (!isMainFrame(event)) return;
  flushRun(state);
  if (isCaused(state, timeOf(event))) {
    state.excluded.push({ event: refOf(event), reason: "navigation-caused" });
    return;
  }
  state.drafts.push({ action: "navigate", url: event.payload.url, events: [event] });
}

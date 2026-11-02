import { lastDraft, type State } from "./state.ts";
import { elementTarget, keyOf, refOf, startOf, type DomEvent, type Draft } from "./types.ts";

const INTERACTIONS = new Set(["click", "dblclick", "drag", "fill", "type", "select", "keyPress"]);

/** Consecutive scrolls of one node are one step at the last position. */
export function onScroll(state: State, event: DomEvent): void {
  const last = lastDraft(state);
  const key = keyOf(event);
  const { scrollX = 0, scrollY = 0 } = event.payload;
  if (last?.action === "scroll" && last.targetKey === key) {
    last.events.push(event);
    last.scrollX = scrollX;
    last.scrollY = scrollY;
    return;
  }
  const target = elementTarget(event.payload.target);
  const draft: Draft = { action: "scroll", scrollX, scrollY, events: [event], targetKey: key };
  state.drafts.push(target ? { ...draft, target } : draft);
}

// Replay scrolls a target into view by itself; a scroll matters when it loads content:
// a request starts before the next step (lazy loading), or a container scrolls before an
// interaction (virtual lists render their items only once scrolled).
function matters(draft: Draft, next: Draft | undefined, requests: number[]): boolean {
  const until = next ? startOf(next) : Number.POSITIVE_INFINITY;
  const start = startOf(draft);
  if (requests.some((time) => time >= start && time < until)) return true;
  return (
    draft.action === "scroll" && draft.target !== undefined && INTERACTIONS.has(next?.action ?? "")
  );
}

/** Drops the scrolls that do not matter, unless `keepScrolls` keeps them all. */
export function applyScrollPolicy(drafts: Draft[], state: State): Draft[] {
  if (state.settings.keepScrolls) return drafts;
  return drafts.filter((draft, index) => {
    if (draft.action !== "scroll") return true;
    const next = drafts.slice(index + 1).find((candidate) => candidate.action !== "scroll");
    if (matters(draft, next, state.requests)) return true;
    for (const event of draft.events) {
      state.excluded.push({ event: refOf(event), reason: "scroll-dropped" });
    }
    return false;
  });
}

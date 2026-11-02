import type { CapturedEvent, ExcludedEvent, NormalizationResult } from "@recnrun/protocol";
import { buildDrafts } from "./builder.ts";
import { exclusionOf } from "./exclusions.ts";
import { applyScrollPolicy } from "./scroll.ts";
import { toStep } from "./steps.ts";
import { settle, startOf, timeOf, type NormalizeOptions } from "./types.ts";

export type { NormalizeOptions } from "./types.ts";

// Time first, then producer and sequence, so the result never depends on the input's order.
function chronological(a: CapturedEvent, b: CapturedEvent): number {
  const time = timeOf(a) - timeOf(b);
  if (time !== 0) return time;
  if (a.producer !== b.producer) return a.producer < b.producer ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * Turns raw captured events into suggested steps, each with the refs of the events it came
 * from; replay-caused, overlay, untrusted, redundant navigation, and dropped scroll events
 * are returned as `excluded` instead.
 */
export function normalize(
  events: CapturedEvent[],
  options: NormalizeOptions = {},
): NormalizationResult {
  const settings = settle(options);
  const ordered = events.toSorted(chronological);
  const rank = new Map(ordered.map((event, index) => [event.id, index]));
  const byRank = (a: { id: string }, b: { id: string }) =>
    (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  const kept: CapturedEvent[] = [];
  const excluded: ExcludedEvent[] = [];
  for (const event of ordered) {
    const exclusion = exclusionOf(event, settings);
    if (exclusion) excluded.push(exclusion);
    else kept.push(event);
  }
  const state = buildDrafts(kept, settings);
  const drafts = state.drafts.toSorted((a, b) => startOf(a) - startOf(b));
  const steps = applyScrollPolicy(drafts, state).map((draft, index) =>
    toStep({ ...draft, events: draft.events.toSorted(byRank) }, index, settings),
  );
  const all = [...excluded, ...state.excluded];
  return { steps, excluded: all.toSorted((a, b) => byRank(a.event, b.event)) };
}

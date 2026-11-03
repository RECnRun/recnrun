import type { Event } from "@recnrun/protocol";

/** Which journal events a query keeps; every field given must match. */
export interface RunEventFilter {
  category?: Event["category"] | undefined;
  stepId?: string | undefined;
  types?: readonly string[] | undefined;
  // The origin of the URL in the event's payload, such as `http://127.0.0.1:4600`.
  origin?: string | undefined;
  profile?: string | undefined;
  // ISO timestamps: `from` inclusive, `to` exclusive.
  from?: string | undefined;
  to?: string | undefined;
}

/** One page of matching events; `next` is the journal position to resume from. */
export interface RunEventPage {
  events: Event[];
  next?: number;
}

/** The origin of a URL, or the text itself when it is not one. */
function originOf(text: string): string {
  try {
    return new URL(text).origin;
  } catch {
    return text;
  }
}

/** The origin of the URL an event's payload names, if it names one. */
function eventOrigin(event: Event): string | undefined {
  const url = (event.payload as Record<string, unknown>)["url"];
  return typeof url === "string" ? originOf(url) : undefined;
}

function inRange(timestamp: string, from: number, to: number): boolean {
  const at = Date.parse(timestamp);
  return at >= from && at < to;
}

type Check = (event: Event) => boolean;

/** A predicate for `filter`, with its origin and time bounds parsed once. */
function eventMatcher(filter: RunEventFilter): Check {
  const checks: Check[] = [];
  const { category, stepId, profile } = filter;
  if (category !== undefined) checks.push((event) => event.category === category);
  if (stepId !== undefined) checks.push((event) => event.stepId === stepId);
  if (profile !== undefined) checks.push((event) => event.profileBinding === profile);
  if (filter.types !== undefined) {
    const types = new Set(filter.types);
    checks.push((event) => types.has(event.type));
  }
  if (filter.origin !== undefined) {
    const origin = originOf(filter.origin);
    checks.push((event) => eventOrigin(event) === origin);
  }
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  checks.push((event) => inRange(event.timestamp, from, to));
  return (event) => checks.every((check) => check(event));
}

/**
 * Up to `limit` events matching `filter`, scanning the journal from position `start`.
 * Positions only grow as the journal is appended to, so a `next` stays valid; a start past
 * the end of the journal is not one a page returned, and answers `undefined`.
 */
export function pageRunEvents(
  events: readonly Event[],
  filter: RunEventFilter,
  page: { start: number; limit: number },
): RunEventPage | undefined {
  if (page.start > events.length) return undefined;
  const matches = eventMatcher(filter);
  const found: Event[] = [];
  for (let position = page.start; position < events.length; position += 1) {
    const event = events[position] as Event;
    if (!matches(event)) continue;
    if (found.length === page.limit) return { events: found, next: position };
    found.push(event);
  }
  return { events: found };
}

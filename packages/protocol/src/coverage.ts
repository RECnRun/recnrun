import { CAPTURE_SURFACES, type CaptureSurface } from "./capabilities.ts";
import { GAP_REASONS, type Event, type GapPayload } from "./events.ts";
import type { RunCoverage } from "./run.ts";
import { PROTOCOL_SCHEMA_VERSION } from "./version.ts";

type GapReason = GapPayload["reason"];

const BY_CATEGORY: Partial<Record<Event["category"], CaptureSurface>> = {
  dom: "dom-events",
  navigation: "navigation",
  target: "navigation",
  console: "console-errors",
  error: "console-errors",
  snapshot: "dom-screen",
};

/** The capture surface a journal event belongs to; engine and step events belong to none. */
export function surfaceOf(event: Event): CaptureSurface | undefined {
  if (event.category === "gap") return event.payload.surface;
  if (event.category === "network")
    return /^(websocket|eventsource)-/.test(event.type) ? "websocket-sse" : "network";
  if (event.category === "storage")
    return event.type.startsWith("cookie") ? "cookies" : "web-storage";
  return BY_CATEGORY[event.category];
}

/** The events a gap says were lost: its count, else the size of its sequence range. */
export function lostBy({ lost, fromSeq, toSeq }: GapPayload): number {
  if (lost !== undefined) return lost;
  return fromSeq !== undefined && toSeq !== undefined && toSeq >= fromSeq ? toSeq - fromSeq + 1 : 0;
}

interface Counts {
  events: number;
  gaps: number;
  lostEvents: number;
  reasons: Set<GapReason>;
}

/** Counts a journal as it is written, for coverage.json at the end. */
export interface CoverageTally {
  add(event: Event): void;
  coverage(runId: string): RunCoverage;
}

const ordered = (reasons: Iterable<GapReason>) =>
  GAP_REASONS.filter((reason) => new Set(reasons).has(reason));

export function tallyCoverage(): CoverageTally {
  const surfaces = new Map<CaptureSurface, Counts>();
  const reasons = new Map<GapReason, { gaps: number; lostEvents: number }>();
  const everywhere = new Set<GapReason>();
  let events = 0;
  const counts = (surface: CaptureSurface): Counts => {
    let found = surfaces.get(surface);
    if (!found) {
      found = { events: 0, gaps: 0, lostEvents: 0, reasons: new Set() };
      surfaces.set(surface, found);
    }
    return found;
  };
  const gap = (payload: GapPayload) => {
    const lost = lostBy(payload);
    const tally = reasons.get(payload.reason) ?? { gaps: 0, lostEvents: 0 };
    reasons.set(payload.reason, { gaps: tally.gaps + 1, lostEvents: tally.lostEvents + lost });
    if (payload.surface === undefined) return everywhere.add(payload.reason);
    const entry = counts(payload.surface);
    entry.gaps += 1;
    entry.lostEvents += lost;
    entry.reasons.add(payload.reason);
  };
  return {
    add(event) {
      if (event.category === "gap") return void gap(event.payload);
      events += 1;
      const surface = surfaceOf(event);
      if (surface) counts(surface).events += 1;
    },
    coverage: (runId) => ({
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      runId,
      events,
      gaps: [...reasons]
        .map(([reason, tally]) => ({ reason, ...tally }))
        .toSorted((a, b) => GAP_REASONS.indexOf(a.reason) - GAP_REASONS.indexOf(b.reason)),
      surfaces: [...surfaces]
        .toSorted(([a], [b]) => CAPTURE_SURFACES.indexOf(a) - CAPTURE_SURFACES.indexOf(b))
        .map(([surface, { reasons: own, ...counted }]) => {
          const touched = ordered([...own, ...everywhere]);
          const status = touched.length > 0 ? ("partial" as const) : ("implemented" as const);
          return { surface, status, reasons: touched, ...counted };
        }),
    }),
  };
}

/** runs/<id>/coverage.json from the run's journal. */
export function coverageOf(runId: string, events: readonly Event[]): RunCoverage {
  const tally = tallyCoverage();
  for (const event of events) tally.add(event);
  return tally.coverage(runId);
}

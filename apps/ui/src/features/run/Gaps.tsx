import { GAP_REASONS, lostBy, type Event, type GapPayload } from "@recnrun/protocol";
import type { Api } from "@/api/api";
import { useLoad } from "@/api/context";
import { EmptyState, Loadable } from "@/ui/States";

type Reason = GapPayload["reason"];

const LABELS: Record<Reason, string> = {
  "buffer-exhausted": "An observer's buffer was full",
  "connection-lost": "The connection to Chrome was lost",
  "journal-truncated": "The journal ended mid-line",
  "target-unattached": "A target ran before it was observed",
  "producer-restarted": "The service restarted during the run",
  "capture-suspended": "Capture was suspended",
  "capture-stopped": "Stopping capture lost pending results",
  "delivery-lost": "Observed events never reached the service",
};

export type GapRow = { reason: Reason; label: string; gaps: number; lostEvents: number };

/** One row per gap reason in the journal, with how many gaps and lost events it reported. */
export function gapRows(events: readonly Event[]): GapRow[] {
  const rows = new Map<Reason, GapRow>();
  for (const event of events) {
    if (event.category !== "gap") continue;
    const { reason } = event.payload;
    const row = rows.get(reason) ?? { reason, label: LABELS[reason], gaps: 0, lostEvents: 0 };
    rows.set(reason, {
      ...row,
      gaps: row.gaps + 1,
      lostEvents: row.lostEvents + lostBy(event.payload),
    });
  }
  return GAP_REASONS.flatMap((reason) => rows.get(reason) ?? []);
}

async function gapEvents(api: Api, runId: string): Promise<Event[]> {
  const events: Event[] = [];
  let cursor: string | undefined;
  do {
    const query = { runId, category: "gap", limit: 1000 } as const;
    const page = await api.call("run.queryEvents", cursor ? { ...query, cursor } : query);
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function describe({ label, gaps, lostEvents }: GapRow): string {
  const lost = lostEvents > 0 ? `, ${plural(lostEvents, "event")} lost` : "";
  return `${label}: ${plural(gaps, "gap")}${lost}`;
}

/** The run's collector gaps by reason: what the recorder missed, never what the application did. */
export function Gaps({ runId }: { runId: string }) {
  const { loaded, reload } = useLoad((api) => gapEvents(api, runId), runId);
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {(events) => {
        const rows = gapRows(events);
        if (rows.length === 0)
          return (
            <EmptyState>The collector reported no gaps: nothing it observes was lost.</EmptyState>
          );
        return (
          <div class="stack">
            <p class="muted">
              A collector gap means the recorder missed part of what happened; it is not a failure
              of the application.
            </p>
            <ul aria-label="Collector gaps by reason">
              {rows.map((row) => (
                <li key={row.reason}>{describe(row)}</li>
              ))}
            </ul>
          </div>
        );
      }}
    </Loadable>
  );
}

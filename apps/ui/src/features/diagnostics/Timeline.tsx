import { EVENT_CATEGORIES } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { type Coverage, type Filters, NO_FILTERS } from "@/features/diagnostics/filters";
import { type TimelineRow, timelineRow } from "@/features/diagnostics/rows";
import { useTimeline } from "@/features/diagnostics/useTimeline";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { EmptyState, ErrorState } from "@/ui/States";

const COVERAGE: { value: Coverage; label: string }[] = [
  { value: "all", label: "Observed events and gaps" },
  { value: "observed", label: "Observed events only" },
  { value: "gaps", label: "Collector gaps only" },
];

type Change = (patch: Partial<Filters>) => void;
type Value = { currentTarget: { value: string } };

function Choices({ draft, steps, change }: { draft: Filters; steps: string[]; change: Change }) {
  return (
    <>
      <Field label="Step">
        <select
          value={draft.stepId}
          onChange={(e: Value) => change({ stepId: e.currentTarget.value })}
        >
          <option value="">Any step</option>
          {steps.map((step) => (
            <option key={step} value={step}>
              {step}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Category">
        <select
          value={draft.category}
          disabled={draft.coverage === "gaps"}
          onChange={(e: Value) => change({ category: e.currentTarget.value })}
        >
          <option value="">Any category</option>
          {EVENT_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Coverage">
        <select
          value={draft.coverage}
          onChange={(e: Value) => change({ coverage: e.currentTarget.value as Coverage })}
        >
          {COVERAGE.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

type FormProps = { steps: string[]; onApply: (filters: Filters) => void };

/** Filters stay a draft until applied, so typing an origin does not query on every key. */
function FiltersForm({ steps, onApply }: FormProps) {
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const change: Change = (patch) => setDraft({ ...draft, ...patch });
  const submit = (event: Event) => {
    event.preventDefault();
    onApply(draft);
  };
  return (
    <form class="row" aria-label="Timeline filters" onSubmit={submit}>
      <Field label="Profile">
        <input
          type="text"
          value={draft.profile}
          onInput={(e: Value) => change({ profile: e.currentTarget.value })}
        />
      </Field>
      <Field label="Origin">
        <input
          type="text"
          placeholder="http://127.0.0.1:4600"
          value={draft.origin}
          onInput={(e: Value) => change({ origin: e.currentTarget.value })}
        />
      </Field>
      <Choices draft={draft} steps={steps} change={change} />
      <Button type="submit">Apply filters</Button>
    </form>
  );
}

function Row({ row }: { row: TimelineRow }) {
  return (
    <li aria-label={`Event ${row.key}`} class={row.gap ? "gap" : undefined}>
      <code>{row.time}</code>{" "}
      {row.gap ? <Badge>collector gap</Badge> : <Badge>{row.category}</Badge>}{" "}
      <code>{row.type}</code>
      {row.stepId ? <span class="muted"> step {row.stepId}</span> : null}
      {row.profile ? <span class="muted"> profile {row.profile}</span> : null}
      {row.cause ? <span class="muted"> ({row.cause})</span> : null}
      {row.summary ? <p class="event-summary">{row.summary}</p> : null}
    </li>
  );
}

function TimelineList({ runId, filters }: { runId: string; filters: Filters }) {
  const { events, loading, error, loadMore } = useTimeline(runId, filters);
  return (
    <div class="stack">
      {events.length === 0 && !loading && !error ? (
        <EmptyState>No event matches these filters.</EmptyState>
      ) : (
        <ol class="list timeline" aria-label="Timeline">
          {events.map((event) => (
            <Row key={event.id} row={timelineRow(event)} />
          ))}
        </ol>
      )}
      {loading ? <p class="muted">Loading…</p> : null}
      {error ? <ErrorState error={error} /> : null}
      {loadMore && !loading ? <Button onClick={loadMore}>Load more</Button> : null}
    </div>
  );
}

/** The run's journal in order, filtered by profile, step, origin, category, and coverage. */
export function Timeline({ runId, steps }: { runId: string; steps: string[] }) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  return (
    <div class="stack">
      <FiltersForm steps={steps} onApply={setFilters} />
      <TimelineList key={JSON.stringify(filters)} runId={runId} filters={filters} />
    </div>
  );
}

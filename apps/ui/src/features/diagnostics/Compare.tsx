import type { RunComparison } from "@recnrun/protocol";
import { useId, useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";
import { type ComparisonView, comparisonView } from "@/features/diagnostics/comparison";
import { recentRuns } from "@/features/diagnostics/recent";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { ErrorState } from "@/ui/States";

function StepTable({ rows }: { rows: ComparisonView["rows"] }) {
  return (
    <div class="scroll">
      <table class="table" aria-label="Steps compared">
        <thead>
          <tr>
            <th>Step</th>
            <th>Baseline</th>
            <th>This run</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.stepId}
              aria-current={row.first ? "step" : undefined}
              class={row.first ? "first" : undefined}
            >
              <td>
                <code>{row.stepId}</code>
                {row.first ? <strong> first divergence</strong> : null}
              </td>
              <td>{row.baseline}</td>
              <td>{row.run}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Result({ comparison }: { comparison: RunComparison }) {
  const view = comparisonView(comparison);
  return (
    <section class="stack" aria-label="Comparison">
      <p>
        <Badge tone={view.tone}>{view.verdict}</Badge>{" "}
        <span class="muted">
          baseline <code>{comparison.baselineRunId}</code>
        </span>
      </p>
      {view.headline ? <p class="divergence">{view.headline}</p> : null}
      {view.sides.length > 0 ? (
        <ul class="list">
          {view.sides.map((side) => (
            <li key={side}>{side}</li>
          ))}
        </ul>
      ) : null}
      {view.message ? <p class="muted">{view.message}</p> : null}
      {view.notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      <StepTable rows={view.rows} />
    </section>
  );
}

/** Compares this run with a baseline run of the same flow through `run.compare`. */
export function Compare({ runId, flowId }: { runId: string; flowId: string }) {
  const api = useApi();
  const listId = useId();
  const { error, busy, run } = useAction();
  const [baseline, setBaseline] = useState("");
  const [comparison, setComparison] = useState<RunComparison>();
  const choices = recentRuns().filter((r) => r.flowId === flowId && r.runId !== runId);
  const submit = (event: Event) => {
    event.preventDefault();
    run(async () => {
      setComparison(undefined);
      setComparison(await api.call("run.compare", { baselineRunId: baseline.trim(), runId }));
    });
  };
  return (
    <div class="stack">
      <form class="row" aria-label="Compare with a baseline" onSubmit={submit}>
        <Field label="Baseline run">
          <input
            type="text"
            list={listId}
            required
            value={baseline}
            onInput={(e: { currentTarget: HTMLInputElement }) => setBaseline(e.currentTarget.value)}
          />
        </Field>
        <datalist id={listId}>
          {choices.map((choice) => (
            <option key={choice.runId} value={choice.runId}>
              {`${choice.status}, started ${choice.startedAt}`}
            </option>
          ))}
        </datalist>
        <Button type="submit" disabled={busy}>
          Compare
        </Button>
      </form>
      {error ? <ErrorState error={error} /> : null}
      {comparison ? <Result comparison={comparison} /> : null}
    </div>
  );
}

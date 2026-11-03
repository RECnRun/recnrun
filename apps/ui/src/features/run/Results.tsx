import type { RunSummary, StepResult } from "@recnrun/protocol";
import { Fragment } from "preact";
import { Badge, type Tone } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";

const TONES: Partial<Record<string, Tone>> = {
  passed: "success",
  failed: "danger",
  error: "danger",
  blocked: "danger",
  interrupted: "danger",
};

const toneOf = (status: string) => TONES[status] ?? "neutral";

function StepRow({ result }: { result: StepResult }) {
  const name = [...(result.stepPath ?? [result.stepId]), result.iterationId].filter(Boolean);
  return (
    <li aria-label={`Result ${name.join(" ")}`}>
      <code>{name.join(" / ")}</code> <Badge tone={toneOf(result.status)}>{result.status}</Badge>
      {result.attempts === undefined ? null : (
        <span class="muted">
          {" "}
          {result.attempts === 1 ? "1 attempt" : `${result.attempts} attempts`}
        </span>
      )}
      {result.error ? (
        <p class="error">
          {result.error.message} <code>{result.error.code}</code>
        </p>
      ) : null}
    </li>
  );
}

/** The live result of each step instance the run has reached. */
export function StepResults({ steps }: { steps: StepResult[] }) {
  if (steps.length === 0) return <EmptyState>No step has run yet.</EmptyState>;
  return (
    <ol class="list" aria-label="Step results">
      {steps.map((result) => (
        <StepRow key={`${result.stepId}-${result.iterationId ?? ""}`} result={result} />
      ))}
    </ol>
  );
}

const COUNTS = ["total", "passed", "failed", "blocked", "cancelled", "indeterminate"] as const;

/** How the run ended: its status, exit code, counts per state, and each failure. */
export function Summary({ summary }: { summary: RunSummary }) {
  return (
    <section class="stack" aria-label="Run summary">
      <p>
        <Badge tone={toneOf(summary.status)}>{summary.status}</Badge> Exit code{" "}
        <code>{summary.exitCode}</code>
      </p>
      <dl class="facts">
        {COUNTS.map((count) => (
          <Fragment key={count}>
            <dt>{count}</dt>
            <dd>{summary.counts[count]}</dd>
          </Fragment>
        ))}
      </dl>
      {summary.failures.length === 0 ? null : (
        <ul class="list" aria-label="Failures">
          {summary.failures.map((failure) => (
            <li key={failure.stepId}>
              <code>{failure.stepId}</code> {failure.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

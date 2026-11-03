import type { NormalizationResult, SuggestedStep } from "@recnrun/protocol";
import { Badge } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import { TargetText } from "@/ui/Target";

// Suggestions with no flow action yet; the editor converts them (PLAN.md F4.1).
const NOT_REPLAYABLE = new Set<SuggestedStep["action"]>(["dblclick", "drag"]);

type Valued = Extract<SuggestedStep, { value: string }>;

function Value({ step }: { step: Valued }) {
  return (
    <>
      {" "}
      <code>{step.value}</code>
      {step.redacted ? <Badge>secret</Badge> : null}
    </>
  );
}

function Detail({ step }: { step: SuggestedStep }) {
  if (step.action === "navigate") return <code>{step.url}</code>;
  if (step.action === "keyPress") return <code>{step.key}</code>;
  if (step.action === "scroll") {
    return (
      <code>
        {step.scrollX}, {step.scrollY}
      </code>
    );
  }
  return (
    <>
      <TargetText target={step.target} />
      {"value" in step ? <Value step={step} /> : null}
    </>
  );
}

/** The steps the recorder suggests from what the person did, in time order. */
export function Suggestions({ result }: { result: NormalizationResult }) {
  if (result.steps.length === 0) {
    return <EmptyState>No suggested steps yet. Use the page in Chrome to record.</EmptyState>;
  }
  return (
    <ol class="list" aria-label="Suggested steps">
      {result.steps.map((step) => (
        <li key={step.id} class="step">
          <strong>{step.action}</strong> <Detail step={step} />{" "}
          {NOT_REPLAYABLE.has(step.action) ? <Badge tone="danger">Not replayable yet</Badge> : null}
        </li>
      ))}
    </ol>
  );
}

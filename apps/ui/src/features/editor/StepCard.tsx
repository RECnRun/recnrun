import type { Step } from "@recnrun/protocol";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TargetText } from "@/ui/Target";

function kindOf(step: Step): string {
  if ("action" in step) return step.action;
  if ("assertion" in step) return `assert ${step.assertion}`;
  return step.builtin;
}

function Details({ step }: { step: Step }) {
  return (
    <dl class="facts">
      {"target" in step && step.target !== undefined ? (
        <>
          <dt>Target</dt>
          <dd>
            <TargetText target={step.target} />
          </dd>
        </>
      ) : null}
      {"value" in step && step.value !== undefined ? (
        <>
          <dt>Value</dt>
          <dd>
            <code>{String(step.value)}</code>
          </dd>
        </>
      ) : null}
      {"expected" in step ? (
        <>
          <dt>Expected</dt>
          <dd>
            <code>{String(step.expected)}</code>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

type StepCardProps = {
  step: Step;
  onDelete: () => void;
  onTimeout: (timeoutMs: number | undefined) => void;
};

const parseTimeout = (text: string) => (text === "" ? undefined : Number.parseInt(text, 10));

/** One step of the flow: what it does, where, with which value, and its own timeout. */
export function StepCard({ step, onDelete, onTimeout }: StepCardProps) {
  return (
    <li class="step card" aria-label={`Step ${step.id}`}>
      <div class="card-header">
        <p>
          <strong>{kindOf(step)}</strong> <code>{step.id}</code>
        </p>
        <Button onClick={onDelete} aria-label={`Delete step ${step.id}`}>
          Delete
        </Button>
      </div>
      <Details step={step} />
      <Field label="Timeout (ms)">
        <input
          type="number"
          min={1}
          value={step.timeoutMs ?? ""}
          placeholder="default"
          onChange={(event) => onTimeout(parseTimeout(event.currentTarget.value))}
        />
      </Field>
    </li>
  );
}

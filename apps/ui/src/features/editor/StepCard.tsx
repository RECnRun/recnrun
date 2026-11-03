import type { Flow, Step, Target } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { moveStep, removeStep, setStepField } from "@/features/editor/edit";
import { StepFields } from "@/features/editor/StepFields";
import { TargetPicker } from "@/features/editor/TargetPicker";
import type { PickerSession } from "@/features/editor/usePicker";
import { Button } from "@/ui/Button";
import { TargetText } from "@/ui/Target";

function kindOf(step: Step): string {
  if ("action" in step) return step.action;
  if ("assertion" in step) return `assert ${step.assertion}`;
  return step.builtin;
}

// Actions whose target is optional still take one.
const OPTIONAL_TARGET = new Set(["keyPress", "waitFor", "scroll"]);

function takesTarget(step: Step): boolean {
  if ("target" in step && step.target !== undefined) return true;
  return "action" in step && OPTIONAL_TARGET.has(step.action);
}

type TargetProps = {
  step: Step;
  session: PickerSession | undefined;
  onChange: (target: Target | undefined) => void;
};

/** The step's target, replaced through the picker once "Apply target" confirms the new one. */
function StepTarget({ step, session, onChange }: TargetProps) {
  const [draft, setDraft] = useState<Target>();
  const [editing, setEditing] = useState(false);
  if (!takesTarget(step)) return null;
  const current = "target" in step ? step.target : undefined;
  const apply = () => {
    onChange(draft);
    setEditing(false);
    setDraft(undefined);
  };
  return (
    <div class="stack">
      <p>
        Target:{" "}
        {current === undefined ? <span class="muted">none</span> : <TargetText target={current} />}{" "}
        <Button aria-label={`Change target of ${step.id}`} onClick={() => setEditing(!editing)}>
          {editing ? "Keep target" : "Change target"}
        </Button>
      </p>
      {editing ? (
        <>
          <TargetPicker target={draft} onChange={setDraft} session={session} />
          <Button variant="primary" disabled={draft === undefined} onClick={apply}>
            Apply target
          </Button>
        </>
      ) : null}
    </div>
  );
}

type StepCardProps = {
  flow: Flow;
  step: Step;
  session: PickerSession | undefined;
  onEdit: (flow: Flow) => void;
};

/** One step of the flow: what it does, where, with which values, moved, edited, or deleted. */
export function StepCard({ flow, step, session, onEdit }: StepCardProps) {
  const index = flow.steps.indexOf(step);
  const set = (key: string, value: unknown) => onEdit(setStepField(flow, step.id, key, value));
  return (
    <li class="step card" aria-label={`Step ${step.id}`}>
      <div class="card-header">
        <p>
          <strong>{kindOf(step)}</strong> <code>{step.id}</code>
        </p>
        <div class="actions">
          <Button
            aria-label={`Move step ${step.id} up`}
            disabled={index === 0}
            onClick={() => onEdit(moveStep(flow, step.id, -1))}
          >
            Up
          </Button>
          <Button
            aria-label={`Move step ${step.id} down`}
            disabled={index === flow.steps.length - 1}
            onClick={() => onEdit(moveStep(flow, step.id, 1))}
          >
            Down
          </Button>
          <Button
            aria-label={`Delete step ${step.id}`}
            onClick={() => onEdit(removeStep(flow, step.id))}
          >
            Delete
          </Button>
        </div>
      </div>
      <StepTarget step={step} session={session} onChange={(target) => set("target", target)} />
      <StepFields step={step} onSet={set} />
    </li>
  );
}

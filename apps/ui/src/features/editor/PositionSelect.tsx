import type { Step } from "@recnrun/protocol";
import { Field } from "@/ui/Field";

type PositionProps = {
  steps: Step[];
  before: string | undefined;
  onChange: (before: string | undefined) => void;
};

/** Where a new step goes: at the end, or before one of the steps. */
export function PositionSelect({ steps, before, onChange }: PositionProps) {
  return (
    <Field label="Position">
      <select
        value={before ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || undefined)}
      >
        <option value="">At the end</option>
        {steps.map((step) => (
          <option key={step.id} value={step.id}>
            Before {step.id}
          </option>
        ))}
      </select>
    </Field>
  );
}

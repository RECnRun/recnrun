import type { Step } from "@recnrun/protocol";
import { Field } from "@/ui/Field";

/** The scalar fields a step may carry, each edited in place when the step has it. */
const TEXT_FIELDS: [key: string, label: string][] = [
  ["url", "URL"],
  ["value", "Value"],
  ["key", "Key"],
  ["expected", "Expected"],
];

type ScalarProps = { label: string; value: string | number; onSet: (value: unknown) => void };

function ScalarField({ label, value, onSet }: ScalarProps) {
  if (typeof value === "number") {
    return (
      <Field label={label}>
        <input
          type="number"
          min={0}
          value={value}
          onChange={(event) => onSet(Number(event.currentTarget.value))}
        />
      </Field>
    );
  }
  return (
    <Field label={label}>
      <input value={value} onInput={(event) => onSet(event.currentTarget.value)} />
    </Field>
  );
}

const parseTimeout = (text: string) => (text === "" ? undefined : Number.parseInt(text, 10));

const isScalar = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

type StepFieldsProps = { step: Step; onSet: (key: string, value: unknown) => void };

/** A step's own values (URL, value, key, expected) and its timeout, edited in place. */
export function StepFields({ step, onSet }: StepFieldsProps) {
  const record = step as Record<string, unknown>;
  return (
    <div class="row">
      {TEXT_FIELDS.map(([key, label]) => {
        const value = record[key];
        return isScalar(value) ? (
          <ScalarField key={key} label={label} value={value} onSet={(next) => onSet(key, next)} />
        ) : null;
      })}
      <Field label="Timeout (ms)">
        <input
          type="number"
          min={1}
          value={step.timeoutMs ?? ""}
          placeholder="default"
          onChange={(event) => onSet("timeoutMs", parseTimeout(event.currentTarget.value))}
        />
      </Field>
    </div>
  );
}

import { useState } from "preact/hooks";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";

export type FieldSpec = { label: string; options?: readonly string[]; optional?: boolean };

type AddFormProps = {
  label: string;
  fields: readonly FieldSpec[];
  submit: string;
  /** Applies the values; a message back is the problem the form shows instead of clearing. */
  onSubmit: (values: string[]) => string | undefined;
};

const initial = (fields: readonly FieldSpec[]) => fields.map((field) => field.options?.[0] ?? "");

type ControlProps = { field: FieldSpec; value: string; onChange: (value: string) => void };

function Control({ field, value, onChange }: ControlProps) {
  if (field.options) {
    return (
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {field.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  }
  return <input value={value} onInput={(event) => onChange(event.currentTarget.value)} />;
}

/** A one-row form that declares something on the flow: fields, one button, and the problem if any. */
export function AddForm({ label, fields, submit, onSubmit }: AddFormProps) {
  const [values, setValues] = useState(() => initial(fields));
  const [problem, setProblem] = useState<string>();
  const ready = fields.every((field, index) => field.optional || values[index] !== "");
  const set = (at: number, value: string) =>
    setValues(values.map((current, index) => (index === at ? value : current)));
  const handle = (event: Event) => {
    event.preventDefault();
    if (!ready) return;
    const result = onSubmit(values);
    setProblem(result);
    if (result === undefined) setValues(initial(fields));
  };
  return (
    <form class="stack" aria-label={label} onSubmit={handle}>
      <div class="row">
        {fields.map((field, index) => (
          <Field key={field.label} label={field.label}>
            <Control field={field} value={values[index] ?? ""} onChange={(v) => set(index, v)} />
          </Field>
        ))}
        <Button type="submit" variant="primary" disabled={!ready}>
          {submit}
        </Button>
      </div>
      {problem ? <p class="muted">{problem}</p> : null}
    </form>
  );
}

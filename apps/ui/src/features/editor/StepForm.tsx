import type { Step } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import {
  type ActionDraft,
  EMPTY_ACTION,
  FORM_ACTIONS,
  type FormAction,
  WAIT_STATES,
  type WaitState,
  buildAction,
} from "@/features/editor/edit";
import { PositionSelect } from "@/features/editor/PositionSelect";
import { TargetPicker } from "@/features/editor/TargetPicker";
import type { PickerSession } from "@/features/editor/usePicker";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";

const TAKES_TARGET: readonly FormAction[] = ["click", "fill", "keyPress", "waitFor"];
const TAKES_URL: readonly FormAction[] = ["navigate", "waitFor"];

type FieldsProps = { draft: ActionDraft; onChange: (patch: Partial<ActionDraft>) => void };

/** The text fields the chosen action reads. */
function ActionFields({ draft, onChange }: FieldsProps) {
  return (
    <div class="row">
      {TAKES_URL.includes(draft.action) ? (
        <Field label="URL">
          <input value={draft.url} onInput={(e) => onChange({ url: e.currentTarget.value })} />
        </Field>
      ) : null}
      {draft.action === "fill" ? (
        <Field label="Value">
          <input value={draft.value} onInput={(e) => onChange({ value: e.currentTarget.value })} />
        </Field>
      ) : null}
      {draft.action === "keyPress" ? (
        <Field label="Key">
          <input value={draft.key} onInput={(e) => onChange({ key: e.currentTarget.value })} />
        </Field>
      ) : null}
      {draft.action === "waitFor" ? (
        <Field label="State">
          <select
            value={draft.state}
            onChange={(e) => onChange({ state: e.currentTarget.value as WaitState })}
          >
            {WAIT_STATES.map((state) => (
              <option key={state}>{state}</option>
            ))}
          </select>
        </Field>
      ) : null}
    </div>
  );
}

type StepFormProps = {
  steps: Step[];
  session?: PickerSession | undefined;
  onAdd: (draft: ActionDraft, before: string | undefined) => void;
};

/** Adds an action step by hand, at the end of the flow or before one of its steps. */
export function StepForm({ steps, session, onAdd }: StepFormProps) {
  const [draft, setDraft] = useState(EMPTY_ACTION);
  const [before, setBefore] = useState<string>();
  const set = (patch: Partial<ActionDraft>) => setDraft({ ...draft, ...patch });
  const ready = buildAction("draft", draft) !== undefined;
  const submit = (event: Event) => {
    event.preventDefault();
    if (!ready) return;
    onAdd(draft, before);
    setDraft({ ...EMPTY_ACTION, action: draft.action });
  };
  return (
    <form class="stack" aria-label="Add a step" onSubmit={submit}>
      <div class="row">
        <Field label="Action">
          <select
            value={draft.action}
            onChange={(e) => set({ action: e.currentTarget.value as FormAction })}
          >
            {FORM_ACTIONS.map((action) => (
              <option key={action}>{action}</option>
            ))}
          </select>
        </Field>
        <PositionSelect steps={steps} before={before} onChange={setBefore} />
      </div>
      <ActionFields draft={draft} onChange={set} />
      {TAKES_TARGET.includes(draft.action) ? (
        <TargetPicker
          target={draft.target}
          onChange={(target) => set({ target })}
          session={session}
        />
      ) : null}
      <Button type="submit" variant="primary" disabled={!ready}>
        Add step
      </Button>
    </form>
  );
}

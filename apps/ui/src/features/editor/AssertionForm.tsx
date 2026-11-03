import type { Target } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import {
  ASSERTION_KINDS,
  type AssertionDraft,
  type AssertionKind,
  needsExpected,
  needsTarget,
} from "@/features/editor/edit";
import { TargetPicker } from "@/features/editor/TargetPicker";
import type { PickerSession } from "@/features/editor/usePicker";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";

type CheckProps = {
  kind: AssertionKind;
  onKind: (kind: AssertionKind) => void;
  expected: string;
  onExpected: (expected: string) => void;
};

function CheckFields({ kind, onKind, expected, onExpected }: CheckProps) {
  return (
    <div class="row">
      <Field label="Kind">
        <select
          value={kind}
          onChange={(event) => onKind(event.currentTarget.value as AssertionKind)}
        >
          {ASSERTION_KINDS.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </Field>
      <Field label="Expected">
        <input
          inputMode={kind === "count" ? "numeric" : "text"}
          value={expected}
          disabled={!needsExpected(kind)}
          onInput={(event) => onExpected(event.currentTarget.value)}
        />
      </Field>
    </div>
  );
}

const ready = ({ kind, target, expected }: AssertionDraft) =>
  needsTarget(kind) ? target !== undefined : expected !== "";

type FormProps = {
  onAdd: (draft: AssertionDraft) => void;
  /** The recording to pick elements on; without one the form takes a typed locator only. */
  session?: PickerSession | undefined;
};

/** Adds an assertion on an element picked in Chrome or described by one locator. */
export function AssertionForm({ onAdd, session }: FormProps) {
  const [target, setTarget] = useState<Target>();
  const [kind, setKind] = useState<AssertionKind>("visible");
  const [expected, setExpected] = useState("");
  const draft: AssertionDraft = { kind, target, expected };
  const submit = (event: Event) => {
    event.preventDefault();
    if (!ready(draft)) return;
    onAdd(draft);
    setTarget(undefined);
    setExpected("");
  };
  return (
    <form class="stack" aria-label="Add an assertion" onSubmit={submit}>
      {needsTarget(kind) ? (
        <TargetPicker target={target} onChange={setTarget} session={session} />
      ) : null}
      <CheckFields kind={kind} onKind={setKind} expected={expected} onExpected={setExpected} />
      <Button type="submit" variant="primary" disabled={!ready(draft)}>
        Add assertion
      </Button>
    </form>
  );
}

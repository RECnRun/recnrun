import type { Step, Target } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import {
  ASSERTION_KINDS,
  type AssertionDraft,
  type AssertionKind,
  needsExpected,
  needsTarget,
} from "@/features/editor/edit";
import { PositionSelect } from "@/features/editor/PositionSelect";
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
    <>
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
    </>
  );
}

const ready = ({ kind, target, expected }: AssertionDraft) =>
  needsTarget(kind) ? target !== undefined : expected !== "";

type FormProps = {
  onAdd: (draft: AssertionDraft, before: string | undefined) => void;
  /** The recording to pick elements on; without one the form takes a typed locator only. */
  session?: PickerSession | undefined;
  /** The steps the assertion can go before; a recording's draft has none to choose from. */
  steps?: Step[] | undefined;
};

/** Adds an assertion on an element picked in Chrome or described by one locator. */
export function AssertionForm({ onAdd, session, steps }: FormProps) {
  const [target, setTarget] = useState<Target>();
  const [kind, setKind] = useState<AssertionKind>("visible");
  const [expected, setExpected] = useState("");
  const [before, setBefore] = useState<string>();
  const draft: AssertionDraft = { kind, target, expected };
  const submit = (event: Event) => {
    event.preventDefault();
    if (!ready(draft)) return;
    onAdd(draft, before);
    setTarget(undefined);
    setExpected("");
  };
  return (
    <form class="stack" aria-label="Add an assertion" onSubmit={submit}>
      <div class="row">
        <CheckFields kind={kind} onKind={setKind} expected={expected} onExpected={setExpected} />
        {steps ? <PositionSelect steps={steps} before={before} onChange={setBefore} /> : null}
      </div>
      {needsTarget(kind) ? (
        <TargetPicker target={target} onChange={setTarget} session={session} />
      ) : null}
      <Button type="submit" variant="primary" disabled={!ready(draft)}>
        Add assertion
      </Button>
    </form>
  );
}

import type { Target } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import {
  ASSERTION_KINDS,
  type AssertionKind,
  FORM_STRATEGIES,
  type FormStrategy,
  locatorFrom,
  needsExpected,
} from "@/features/editor/edit";
import { usePicker } from "@/features/editor/usePicker";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { ErrorState } from "@/ui/States";
import { TargetText } from "@/ui/Target";

type Locator = { strategy: FormStrategy; value: string };

type TargetProps = {
  locator: Locator;
  onLocator: (locator: Locator) => void;
  picked: Target | undefined;
  onClear: () => void;
};

function TargetFields({ locator, onLocator, picked, onClear }: TargetProps) {
  if (picked) {
    return (
      <div class="row">
        <p>
          Picked: <TargetText target={picked} />
        </p>
        <Button onClick={onClear}>Clear</Button>
      </div>
    );
  }
  return (
    <div class="row">
      <Field label="Strategy">
        <select
          value={locator.strategy}
          onChange={(event) =>
            onLocator({ ...locator, strategy: event.currentTarget.value as FormStrategy })
          }
        >
          {FORM_STRATEGIES.map((strategy) => (
            <option key={strategy}>{strategy}</option>
          ))}
        </select>
      </Field>
      <Field label="Locator">
        <input
          value={locator.value}
          onInput={(event) => onLocator({ ...locator, value: event.currentTarget.value })}
        />
      </Field>
    </div>
  );
}

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

type FormProps = { onAdd: (target: Target, kind: AssertionKind, expected: string) => void };

/** Adds an assertion on an element picked in Chrome or described by one locator. */
export function AssertionForm({ onAdd }: FormProps) {
  const [locator, setLocator] = useState<Locator>({ strategy: "css", value: "" });
  const [picked, setPicked] = useState<Target>();
  const [kind, setKind] = useState<AssertionKind>("visible");
  const [expected, setExpected] = useState("");
  const picker = usePicker(setPicked);
  const typed = locator.value ? locatorFrom(locator.strategy, locator.value) : undefined;
  const target = picked ?? typed;
  const submit = (event: Event) => {
    event.preventDefault();
    if (!target) return;
    onAdd(target, kind, expected);
    setPicked(undefined);
    setLocator({ ...locator, value: "" });
    setExpected("");
  };
  return (
    <form class="stack" aria-label="Add an assertion" onSubmit={submit}>
      <TargetFields
        locator={locator}
        onLocator={setLocator}
        picked={picked}
        onClear={() => setPicked(undefined)}
      />
      <CheckFields kind={kind} onKind={setKind} expected={expected} onExpected={setExpected} />
      <div class="row">
        {picker.picking ? (
          <Button onClick={picker.cancel}>Cancel picking</Button>
        ) : (
          <Button onClick={picker.start} disabled={picker.busy}>
            Pick in Chrome
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!target}>
          Add assertion
        </Button>
      </div>
      {picker.picking ? <p class="muted">Click the element in Chrome.</p> : null}
      {picker.error ? <ErrorState error={picker.error} /> : null}
    </form>
  );
}

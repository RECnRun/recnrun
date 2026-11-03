import type { LocatorEntry, LocatorList, Target } from "@recnrun/protocol";
import { useEffect, useId, useState } from "preact/hooks";
import {
  EMPTY_LOCATOR,
  FORM_STRATEGIES,
  type FormStrategy,
  type TypedLocator,
  locatorFrom,
  shorthandOf,
} from "@/features/editor/targets";
import { type PickerSession, usePicker } from "@/features/editor/usePicker";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { ErrorState } from "@/ui/States";
import { TargetText } from "@/ui/Target";

type TypedProps = { typed: TypedLocator; onType: (typed: TypedLocator) => void };

function TypedFields({ typed, onType }: TypedProps) {
  return (
    <div class="row">
      <Field label="Strategy">
        <select
          value={typed.strategy}
          onChange={(event) =>
            onType({ ...typed, strategy: event.currentTarget.value as FormStrategy })
          }
        >
          {FORM_STRATEGIES.map((strategy) => (
            <option key={strategy}>{strategy}</option>
          ))}
        </select>
      </Field>
      <Field label="Locator">
        <input
          value={typed.value}
          onInput={(event) => onType({ ...typed, value: event.currentTarget.value })}
        />
      </Field>
    </div>
  );
}

type CandidatesProps = { entries: LocatorEntry[]; chosen: number; onChoose: (i: number) => void };

/** The locators the pick suggests, best first; the chosen one becomes the target. */
function Candidates({ entries, chosen, onChoose }: CandidatesProps) {
  const group = useId();
  return (
    <div class="stack" role="radiogroup" aria-label="Candidates">
      {entries.map((entry, index) => (
        <label key={index} class="field">
          <input
            type="radio"
            name={group}
            checked={index === chosen}
            onChange={() => onChoose(index)}
          />{" "}
          <TargetText target={entry} />
        </label>
      ))}
    </div>
  );
}

type Picker = ReturnType<typeof usePicker>;

function PickerControls({ picker }: { picker: Picker }) {
  if (!picker.available)
    return <p class="muted">Pick elements in Chrome while recording; here, type a locator.</p>;
  if (picker.picking) return <Button onClick={picker.cancel}>Cancel picking</Button>;
  return (
    <Button onClick={picker.start} disabled={picker.busy}>
      Pick in Chrome
    </Button>
  );
}

type TargetPickerProps = {
  target: Target | undefined;
  onChange: (target: Target | undefined) => void;
  /** The recording to pick elements on; without one the picker takes a typed locator only. */
  session?: PickerSession | undefined;
};

/** One target: picked in Chrome and chosen among the pick's candidates, or typed as one locator. */
export function TargetPicker({ target, onChange, session }: TargetPickerProps) {
  const [typed, setTyped] = useState(EMPTY_LOCATOR);
  const [candidates, setCandidates] = useState<LocatorEntry[]>();
  const [chosen, setChosen] = useState(0);
  const choose = (entries: LocatorEntry[], index: number) => {
    setChosen(index);
    const entry = entries[index];
    if (entry) onChange(shorthandOf(entry));
  };
  const picker = usePicker(session, (list: LocatorList) => {
    setCandidates(list.locators);
    choose(list.locators, 0);
  });
  const type = (next: TypedLocator) => {
    setTyped(next);
    onChange(next.value ? locatorFrom(next.strategy, next.value) : undefined);
  };
  const clear = () => {
    setCandidates(undefined);
    setTyped(EMPTY_LOCATOR);
    onChange(undefined);
  };
  // The owner clears the target once it used it; the fields follow unless they are empty already.
  useEffect(() => {
    if (target === undefined && (candidates !== undefined || typed.value !== "")) {
      setCandidates(undefined);
      setTyped(EMPTY_LOCATOR);
    }
  }, [target]);
  return (
    <div class="stack">
      {candidates ? (
        <Candidates entries={candidates} chosen={chosen} onChoose={(i) => choose(candidates, i)} />
      ) : (
        <TypedFields typed={typed} onType={type} />
      )}
      <div class="row">
        <PickerControls picker={picker} />
        {target !== undefined ? <Button onClick={clear}>Clear</Button> : null}
      </div>
      {picker.picking ? <p class="muted">Click the element in Chrome.</p> : null}
      {picker.error ? <ErrorState error={picker.error} /> : null}
    </div>
  );
}

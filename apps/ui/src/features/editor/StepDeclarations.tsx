import type { Flow, Step } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { isName, literalValue, parameterize, toggleRequirement } from "@/features/editor/declare";
import { setStepField } from "@/features/editor/edit";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";

type Props = { flow: Flow; step: Step; onEdit: (flow: Flow) => void };

/** The step's actor among the flow's; an undeclared one stays listed until it is changed. */
function ActorSelect({ flow, step, onEdit }: Props) {
  const names = Object.keys(flow.actors);
  if (step.actor !== undefined && !names.includes(step.actor)) names.push(step.actor);
  if (names.length === 0) return null;
  const choose = (actor: string) =>
    onEdit(setStepField(flow, step.id, "actor", actor === "" ? undefined : actor));
  return (
    <Field label="Actor">
      <select value={step.actor ?? ""} onChange={(event) => choose(event.currentTarget.value)}>
        <option value="">No actor</option>
        {names.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
    </Field>
  );
}

function RequirementLinks({ flow, step, onEdit }: Props) {
  if (flow.requirements.length === 0) return null;
  return (
    <div class="row" role="group" aria-label="Requirements">
      {flow.requirements.map(({ id }) => (
        <Field key={id} label={id}>
          <input
            type="checkbox"
            checked={step.requirements?.includes(id) ?? false}
            onChange={() => onEdit(toggleRequirement(flow, step.id, id))}
          />
        </Field>
      ))}
    </div>
  );
}

/** Turns the step's literal value into a reference to an input, new or declared already. */
function Parameterize({ flow, step, onEdit }: Props) {
  const [name, setName] = useState<string>();
  if (literalValue(step) === undefined) return null;
  if (name === undefined) {
    return (
      <Button aria-label={`Parameterize step ${step.id}`} onClick={() => setName("")}>
        Parameterize
      </Button>
    );
  }
  const replace = () => {
    onEdit(parameterize(flow, step.id, name));
    setName(undefined);
  };
  return (
    <div class="row">
      <Field label="Input name">
        <input value={name} onInput={(event) => setName(event.currentTarget.value)} />
      </Field>
      <Button variant="primary" disabled={!isName(name)} onClick={replace}>
        Replace with input
      </Button>
      <Button onClick={() => setName(undefined)}>Cancel</Button>
    </div>
  );
}

/** How the step relates to the flow's declarations: its actor, requirement links, and inputs. */
export function StepDeclarations(props: Props) {
  return (
    <div class="row">
      <ActorSelect {...props} />
      <RequirementLinks {...props} />
      <Parameterize {...props} />
    </div>
  );
}

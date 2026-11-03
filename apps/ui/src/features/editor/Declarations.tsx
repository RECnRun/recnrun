import { type Flow, ID_PROBLEM, INPUT_TYPES, NAME_PROBLEM } from "@recnrun/protocol";
import { AddForm } from "@/features/editor/AddForm";
import {
  type Input,
  type InputType,
  addActor,
  addInput,
  addRequirement,
  isId,
  isName,
  parseDefault,
  removeActor,
  removeInput,
  removeRequirement,
} from "@/features/editor/declare";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";

type Entry = { key: string; detail: string };

type ListProps = { label: string; noun: string; entries: Entry[]; onRemove: (key: string) => void };

function DeclaredList({ label, noun, entries, onRemove }: ListProps) {
  if (entries.length === 0) return <p class="muted">No {label.toLowerCase()} yet.</p>;
  return (
    <ul class="list" aria-label={label}>
      {entries.map(({ key, detail }) => (
        <li key={key} class="row">
          <code>{key}</code>
          <span class="muted">{detail}</span>
          <Button aria-label={`Remove ${noun} ${key}`} onClick={() => onRemove(key)}>
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

type Props = { flow: Flow; onEdit: (flow: Flow) => void };

function describeInput(input: Input): string {
  const flags = [input.type, input.required ? "required" : "", input.secret ? "secret" : ""];
  const parts = flags.filter((flag) => flag !== "");
  if (input.default !== undefined) parts.push(`default ${JSON.stringify(input.default)}`);
  return parts.join(", ");
}

const problemOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Inputs({ flow, onEdit }: Props) {
  const add = ([name = "", type = "string", text = ""]: string[]) => {
    if (!isName(name)) return NAME_PROBLEM;
    if (Object.hasOwn(flow.inputs, name)) return `An input named ${name} exists already.`;
    try {
      const value = parseDefault(type as InputType, text);
      onEdit(addInput(flow, name, { type: type as InputType, default: value }));
      return undefined;
    } catch (error) {
      return problemOf(error);
    }
  };
  const entries = Object.entries(flow.inputs).map(([key, input]) => ({
    key,
    detail: describeInput(input),
  }));
  return (
    <Card title="Inputs">
      <DeclaredList
        label="Inputs"
        noun="input"
        entries={entries}
        onRemove={(name) => onEdit(removeInput(flow, name))}
      />
      <AddForm
        label="Add an input"
        fields={[
          { label: "Name" },
          { label: "Type", options: INPUT_TYPES },
          { label: "Default", optional: true },
        ]}
        submit="Add input"
        onSubmit={add}
      />
    </Card>
  );
}

function Actors({ flow, onEdit }: Props) {
  const add = ([name = "", description = ""]: string[]) => {
    if (!isName(name)) return NAME_PROBLEM;
    if (Object.hasOwn(flow.actors, name)) return `An actor named ${name} exists already.`;
    onEdit(addActor(flow, name, description));
    return undefined;
  };
  const entries = Object.entries(flow.actors).map(([key, actor]) => ({
    key,
    detail: actor.description ?? "",
  }));
  return (
    <Card title="Actors">
      <DeclaredList
        label="Actors"
        noun="actor"
        entries={entries}
        onRemove={(name) => onEdit(removeActor(flow, name))}
      />
      <AddForm
        label="Add an actor"
        fields={[{ label: "Name" }, { label: "Description", optional: true }]}
        submit="Add actor"
        onSubmit={add}
      />
    </Card>
  );
}

function Requirements({ flow, onEdit }: Props) {
  const add = ([id = "", text = ""]: string[]) => {
    if (!isId(id)) return ID_PROBLEM;
    if (flow.requirements.some((requirement) => requirement.id === id)) {
      return `A requirement with the id ${id} exists already.`;
    }
    onEdit(addRequirement(flow, { id, text }));
    return undefined;
  };
  const entries = flow.requirements.map(({ id, text }) => ({ key: id, detail: text }));
  return (
    <Card title="Requirements">
      <DeclaredList
        label="Requirements"
        noun="requirement"
        entries={entries}
        onRemove={(id) => onEdit(removeRequirement(flow, id))}
      />
      <AddForm
        label="Add a requirement"
        fields={[{ label: "Id" }, { label: "Text" }]}
        submit="Add requirement"
        onSubmit={add}
      />
    </Card>
  );
}

/** What the flow declares besides its steps: inputs, actors, and the requirements steps cover. */
export function Declarations(props: Props) {
  return (
    <>
      <Inputs {...props} />
      <Actors {...props} />
      <Requirements {...props} />
    </>
  );
}

import { useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";
import { isId } from "@/features/editor/declare";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Field } from "@/ui/Field";
import { ErrorState } from "@/ui/States";

type Props = { flowId: string; name: string; onDuplicated: (flowId: string) => void };

/** Copies the flow as saved into a new flow with its own id, name, and revisions. */
export function Duplicate({ flowId, name, onDuplicated }: Props) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const submit = (event: Event) => {
    event.preventDefault();
    if (!isId(newId)) return;
    run(async () => {
      const params = { flowId, newId, ...(newName !== "" && { name: newName }) };
      onDuplicated((await api.call("flow.duplicate", params)).flowId);
    });
  };
  return (
    <Card title="Duplicate flow">
      <form class="stack" aria-label="Duplicate flow" onSubmit={submit}>
        <p class="muted">Copies the flow as last saved; edits not yet saved stay here.</p>
        <div class="row">
          <Field label="New id">
            <input value={newId} onInput={(event) => setNewId(event.currentTarget.value)} />
          </Field>
          <Field label="New name">
            <input
              value={newName}
              placeholder={name}
              onInput={(event) => setNewName(event.currentTarget.value)}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !isId(newId)}>
            Duplicate
          </Button>
        </div>
        {error ? <ErrorState error={error} /> : null}
      </form>
    </Card>
  );
}

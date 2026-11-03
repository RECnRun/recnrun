import type { Flow, Target } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { useAction, useApi, useLoad } from "@/api/context";
import { AssertionForm } from "@/features/editor/AssertionForm";
import { StepCard } from "@/features/editor/StepCard";
import {
  type AssertionKind,
  addStep,
  buildAssertion,
  nextAssertionId,
  removeStep,
  setTimeoutMs,
} from "@/features/editor/edit";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { EmptyState, ErrorState, Loadable } from "@/ui/States";

type StepsProps = { flow: Flow; onEdit: (flow: Flow) => void };

function Steps({ flow, onEdit }: StepsProps) {
  if (flow.steps.length === 0) return <EmptyState>This flow has no steps yet.</EmptyState>;
  return (
    <ol class="list" aria-label="Steps">
      {flow.steps.map((step) => (
        <StepCard
          key={step.id}
          step={step}
          onDelete={() => onEdit(removeStep(flow, step.id))}
          onTimeout={(timeoutMs) => onEdit(setTimeoutMs(flow, step.id, timeoutMs))}
        />
      ))}
    </ol>
  );
}

const short = (revision: string) => revision.slice(0, 12);

type FlowEditorProps = { flowId: string; initial: Flow; revision: string; onRun: () => void };

function FlowEditor({ flowId, initial, revision, onRun }: FlowEditorProps) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [flow, setFlow] = useState(initial);
  const [saved, setSaved] = useState(revision);
  const [dirty, setDirty] = useState(false);
  const edit = (next: Flow) => {
    setFlow(next);
    setDirty(true);
  };
  const save = () =>
    run(async () => {
      setSaved((await api.call("flow.save", { flowId, flow })).revision);
      setDirty(false);
    });
  const add = (target: Target, kind: AssertionKind, expected: string) =>
    edit(addStep(flow, buildAssertion(nextAssertionId(flow), kind, target, expected)));
  const actions = (
    <>
      <Button variant="primary" onClick={save} disabled={busy}>
        Save
      </Button>
      <Button onClick={onRun}>Run</Button>
    </>
  );
  return (
    <>
      <Card title={flow.name} actions={actions}>
        <p>
          Revision <code aria-label="Revision">{short(saved)}</code>{" "}
          {dirty ? <Badge tone="danger">Unsaved changes</Badge> : null}
        </p>
        {error ? <ErrorState error={error} /> : null}
        <Steps flow={flow} onEdit={edit} />
      </Card>
      <Card title="Add an assertion">
        <AssertionForm onAdd={add} />
      </Card>
    </>
  );
}

type EditorProps = { flowId: string; onRun: () => void };

/** Loads a flow, edits its steps and assertions locally, and saves them as a new revision. */
export function Editor({ flowId, onRun }: EditorProps) {
  const { loaded, reload } = useLoad((api) => api.call("flow.get", { flowId }), flowId);
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {({ flow, manifest }) => (
        <FlowEditor flowId={flowId} initial={flow} revision={manifest.revision} onRun={onRun} />
      )}
    </Loadable>
  );
}

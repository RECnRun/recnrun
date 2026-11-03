import type { Flow } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { useAction, useApi, useLoad } from "@/api/context";
import { AssertionForm } from "@/features/editor/AssertionForm";
import { StepCard } from "@/features/editor/StepCard";
import {
  type AssertionDraft,
  addStep,
  buildAssertion,
  nextAssertionId,
  removeStep,
  setTimeoutMs,
} from "@/features/editor/edit";
import { useEditorSession } from "@/features/editor/useEditorSession";
import type { PickerSession } from "@/features/editor/usePicker";
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

type FlowEditorProps = {
  initial: Flow;
  revision: string;
  session: PickerSession | undefined;
  onRun: () => void;
};

function FlowEditor({ initial, revision, session, onRun }: FlowEditorProps) {
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
      setSaved((await api.call("flow.save", { flow })).revision);
      setDirty(false);
    });
  const add = (draft: AssertionDraft) =>
    edit(addStep(flow, buildAssertion(nextAssertionId(flow), draft)));
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
        <AssertionForm onAdd={add} session={session} />
      </Card>
    </>
  );
}

type EditorProps = {
  flowId: string;
  /** The recording this tab runs, whose page the picker uses; without one, locators are typed. */
  sessionId?: string | undefined;
  onRun: () => void;
};

/** Loads a flow, edits its steps and assertions locally, and saves them as a new revision. */
export function Editor({ flowId, sessionId, onRun }: EditorProps) {
  const session = useEditorSession(sessionId);
  const { loaded, reload } = useLoad((api) => api.call("flow.get", { flowId }), flowId);
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {({ flow, revision }) => (
        <FlowEditor initial={flow} revision={revision} session={session} onRun={onRun} />
      )}
    </Loadable>
  );
}

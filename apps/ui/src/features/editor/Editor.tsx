import type { Flow } from "@recnrun/protocol";
import { useLoad } from "@/api/context";
import { AssertionForm } from "@/features/editor/AssertionForm";
import { Declarations } from "@/features/editor/Declarations";
import { Duplicate } from "@/features/editor/Duplicate";
import {
  type ActionDraft,
  type AssertionDraft,
  buildAction,
  buildAssertion,
  insertStep,
  nextStepId,
} from "@/features/editor/edit";
import { type RevisionEntry, Revisions, short } from "@/features/editor/Revisions";
import { StepCard } from "@/features/editor/StepCard";
import { StepForm } from "@/features/editor/StepForm";
import { useEditorSession } from "@/features/editor/useEditorSession";
import { useFlowDraft } from "@/features/editor/useFlowDraft";
import type { PickerSession } from "@/features/editor/usePicker";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { EmptyState, ErrorState, Loadable } from "@/ui/States";

type StepsProps = {
  flow: Flow;
  session: PickerSession | undefined;
  onEdit: (flow: Flow) => void;
};

function Steps({ flow, session, onEdit }: StepsProps) {
  if (flow.steps.length === 0) return <EmptyState>This flow has no steps yet.</EmptyState>;
  return (
    <ol class="list" aria-label="Steps">
      {flow.steps.map((step) => (
        <StepCard key={step.id} flow={flow} step={step} session={session} onEdit={onEdit} />
      ))}
    </ol>
  );
}

type FlowEditorProps = {
  flowId: string;
  initial: Flow;
  revision: string;
  revisions: RevisionEntry[];
  session: PickerSession | undefined;
  onRun: () => void;
  onDuplicated: (flowId: string) => void;
};

function FlowEditor(props: FlowEditorProps) {
  const { flowId, session, onRun, onDuplicated } = props;
  const draft = useFlowDraft(props);
  const { flow, edit } = draft;
  const addAssertion = (draft: AssertionDraft, before: string | undefined) =>
    edit(insertStep(flow, buildAssertion(nextStepId(flow, "assert"), draft), before));
  const addAction = (draft: ActionDraft, before: string | undefined) => {
    const step = buildAction(nextStepId(flow, draft.action), draft);
    if (step) edit(insertStep(flow, step, before));
  };
  const actions = (
    <>
      <Button variant="primary" onClick={draft.save} disabled={draft.busy}>
        Save
      </Button>
      <Button onClick={onRun}>Run</Button>
    </>
  );
  return (
    <>
      <Card title={flow.name} actions={actions}>
        <p>
          Revision <code aria-label="Revision">{short(draft.saved)}</code>{" "}
          {draft.dirty ? <Badge tone="danger">Unsaved changes</Badge> : null}
        </p>
        {draft.error ? <ErrorState error={draft.error} /> : null}
        <Steps flow={flow} session={session} onEdit={edit} />
      </Card>
      <Card title="Add a step">
        <StepForm steps={flow.steps} session={session} onAdd={addAction} />
      </Card>
      <Card title="Add an assertion">
        <AssertionForm onAdd={addAssertion} session={session} steps={flow.steps} />
      </Card>
      <Declarations flow={flow} onEdit={edit} />
      <Revisions flowId={flowId} history={draft.history} current={draft.saved} flow={flow} />
      <Duplicate flowId={flowId} name={flow.name} onDuplicated={onDuplicated} />
    </>
  );
}

type EditorProps = {
  flowId: string;
  /** The recording this tab runs, whose page the picker uses; without one, locators are typed. */
  sessionId?: string | undefined;
  onRun: () => void;
  onDuplicated: (flowId: string) => void;
};

/** Loads a flow, edits every part of it locally, and saves the result as a new revision. */
export function Editor({ flowId, sessionId, onRun, onDuplicated }: EditorProps) {
  const session = useEditorSession(sessionId);
  const { loaded, reload } = useLoad((api) => api.call("flow.get", { flowId }), flowId);
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {({ flow, manifest, revision }) => (
        <FlowEditor
          flowId={flowId}
          initial={flow}
          revision={revision}
          revisions={manifest.revisions}
          session={session}
          onRun={onRun}
          onDuplicated={onDuplicated}
        />
      )}
    </Loadable>
  );
}

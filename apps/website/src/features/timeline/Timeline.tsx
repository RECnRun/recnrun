import type { Step, Workflow } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";
import { StepRow } from "@/features/timeline/StepRow";
import { mergeStep } from "@/features/timeline/step-view";
import type { ExtensionGateway } from "@/services/extension";
import { EmptyState } from "@/ui/EmptyState";
import { errorMessage } from "@/ui/error-message";
import { plural } from "@/ui/plural";
import { StatusBadge } from "@/ui/StatusBadge";
import { TagList } from "@/ui/TagList";

type TimelineState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; workflow: Workflow; steps: Step[] }
  | { status: "failed"; message: string };

async function load(gateway: ExtensionGateway, id: string): Promise<TimelineState> {
  const workflows = await gateway.listWorkflows();
  const workflow = workflows.find((candidate) => candidate.id === id);
  if (!workflow) return { status: "missing" };
  return { status: "ready", workflow, steps: await gateway.listSteps(id) };
}

/** Lists the stored steps, then appends the ones the extension pushes for this workflow. */
function useTimeline(gateway: ExtensionGateway, id: string): TimelineState {
  const [state, setState] = useState<TimelineState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    load(gateway, id).then(
      (next) => active && setState(next),
      (error: unknown) => active && setState({ status: "failed", message: errorMessage(error) }),
    );
    const unsubscribe = gateway.onStep((step) => {
      if (step.workflowId !== id) return;
      setState((current) =>
        current.status === "ready"
          ? { ...current, steps: mergeStep(current.steps, step) }
          : current,
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [gateway, id]);
  return state;
}

interface Props {
  gateway: ExtensionGateway;
  id: string;
  backHref: string;
}

export function Timeline({ gateway, id, backHref }: Props) {
  const state = useTimeline(gateway, id);
  const back = (
    <p>
      <a href={backHref}>← All workflows</a>
    </p>
  );
  switch (state.status) {
    case "loading":
      return <p role="status">Loading steps…</p>;
    case "missing":
      return (
        <>
          {back}
          <EmptyState title="Workflow not found" message={`No workflow has the id ${id}.`} />
        </>
      );
    case "failed":
      return (
        <>
          {back}
          <EmptyState title="Could not read this workflow" message={state.message} />
        </>
      );
    case "ready":
      return (
        <>
          {back}
          <TimelineView workflow={state.workflow} steps={state.steps} />
        </>
      );
  }
}

function TimelineView({ workflow, steps }: { workflow: Workflow; steps: Step[] }) {
  return (
    <section aria-labelledby="timeline-title">
      <header class="card-header">
        <h2 id="timeline-title">{workflow.title}</h2>
        <StatusBadge status={workflow.status} />
      </header>
      {workflow.description && <p class="muted">{workflow.description}</p>}
      <TagList tags={workflow.tags} />
      <p class="muted" data-testid="step-count">
        {plural(steps.length, "step")}
      </p>
      {steps.length === 0 ? (
        <EmptyState
          title="No steps yet"
          message="Interact with a page in the recording tab group and the steps appear here."
        />
      ) : (
        <ol class="steps">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      )}
    </section>
  );
}

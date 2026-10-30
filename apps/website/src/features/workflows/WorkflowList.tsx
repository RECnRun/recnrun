import type { Workflow } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";
import { filterWorkflows, upsertWorkflow } from "@/features/workflows/workflow-view";
import { WorkflowCard } from "@/features/workflows/WorkflowCard";
import type { ExtensionGateway } from "@/services/extension";
import { EmptyState } from "@/ui/EmptyState";
import { errorMessage } from "@/ui/error-message";

type ListState =
  | { status: "loading" }
  | { status: "ready"; workflows: Workflow[] }
  | { status: "failed"; message: string };

/** Lists once, then applies the workflow changes the extension pushes. */
function useWorkflows(gateway: ExtensionGateway): [ListState, () => void] {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  const reload = () => setGeneration((n) => n + 1);
  useEffect(() => {
    let active = true;
    gateway.listWorkflows().then(
      (workflows) => active && setState({ status: "ready", workflows }),
      (error: unknown) => active && setState({ status: "failed", message: errorMessage(error) }),
    );
    const unsubscribe = gateway.onWorkflowChanged((workflow) =>
      setState((current) =>
        current.status === "ready"
          ? { ...current, workflows: upsertWorkflow(current.workflows, workflow) }
          : current,
      ),
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [gateway, generation]);
  return [state, reload];
}

interface Props {
  gateway: ExtensionGateway;
  hrefFor: (id: string) => string;
}

export function WorkflowList({ gateway, hrefFor }: Props) {
  const [state, reload] = useWorkflows(gateway);
  const [query, setQuery] = useState("");
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const remove = (id: string) => {
    gateway.deleteWorkflow(id).then(reload, (error: unknown) => setFailure(errorMessage(error)));
  };

  if (state.status === "loading") return <p role="status">Loading workflows…</p>;
  if (state.status === "failed") {
    return <EmptyState title="Could not read your workflows" message={state.message} />;
  }
  if (state.workflows.length === 0) {
    return (
      <EmptyState
        title="No workflows yet"
        message="Start a workflow from the extension popup, or let your agent start one."
      />
    );
  }
  const shown = filterWorkflows(state.workflows, query);
  return (
    <section aria-labelledby="workflows-title">
      <header class="list-header">
        <h2 id="workflows-title">Workflows</h2>
        <input
          type="search"
          aria-label="Filter by tag or title"
          placeholder="Filter by tag, e.g. env:local"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </header>
      {failure && <p role="alert">{failure}</p>}
      {shown.length === 0 && <p class="muted">No workflow matches “{query.trim()}”.</p>}
      <div class="cards">
        {shown.map((workflow) => (
          <WorkflowCard
            key={workflow.id}
            workflow={workflow}
            href={hrefFor(workflow.id)}
            onDelete={remove}
          />
        ))}
      </div>
    </section>
  );
}

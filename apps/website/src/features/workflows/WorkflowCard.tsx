import type { Workflow } from "@recnrun/domain";
import { formatUpdatedAt } from "@/features/workflows/workflow-view";
import { StatusBadge } from "@/ui/StatusBadge";
import { TagList } from "@/ui/TagList";

interface Props {
  workflow: Workflow;
  href: string;
  onDelete: (id: string) => void;
}

export function WorkflowCard({ workflow, href, onDelete }: Props) {
  const titleId = `workflow-${workflow.id}`;
  return (
    <article class="workflow card" aria-labelledby={titleId}>
      <header class="card-header">
        <h2 id={titleId}>
          <a href={href}>{workflow.title}</a>
        </h2>
        <StatusBadge status={workflow.status} />
      </header>
      {workflow.description && <p class="muted">{workflow.description}</p>}
      <TagList tags={workflow.tags} />
      <footer class="card-footer">
        <span class="muted">Updated {formatUpdatedAt(workflow.updatedAt)}</span>
        {workflow.status === "stopped" && (
          <button type="button" class="button button-quiet" onClick={() => onDelete(workflow.id)}>
            Delete
          </button>
        )}
      </footer>
    </article>
  );
}

import type { Workflow } from "@recnrun/domain";

/** Formats in UTC so a workflow reads the same on every machine. */
export function formatUpdatedAt(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Replaces the workflow with the same id, or adds it; newest update first, like the extension lists them. */
export function upsertWorkflow(workflows: readonly Workflow[], workflow: Workflow): Workflow[] {
  return [...workflows.filter((listed) => listed.id !== workflow.id), workflow].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

/** Keeps the workflows whose title or a tag contains the query, ignoring case. */
export function filterWorkflows(workflows: readonly Workflow[], query: string): Workflow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...workflows];
  return workflows.filter(
    (workflow) =>
      workflow.title.toLowerCase().includes(needle) ||
      workflow.tags.some((tag) => tag.toLowerCase().includes(needle)),
  );
}

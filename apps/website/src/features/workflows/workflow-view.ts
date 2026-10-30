import type { Workflow } from "@recnrun/domain";

/** Formats in UTC so a workflow reads the same on every machine. */
export function formatUpdatedAt(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
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

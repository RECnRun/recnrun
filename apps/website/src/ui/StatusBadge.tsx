import type { WorkflowStatus } from "@recnrun/domain";

const LABELS: Record<WorkflowStatus, string> = { recording: "Recording", stopped: "Stopped" };

export function StatusBadge({ status }: { status: WorkflowStatus }) {
  return <span class={`status status-${status}`}>{LABELS[status]}</span>;
}

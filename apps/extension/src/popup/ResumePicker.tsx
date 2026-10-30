import type { Workflow } from "@recnrun/domain";
import { useState } from "preact/hooks";

export function ResumePicker({
  stopped,
  onResume,
}: {
  stopped: Workflow[];
  onResume: (id: string) => void;
}) {
  const [resumeId, setResumeId] = useState(stopped[0]?.id ?? "");
  if (stopped.length === 0) return null;
  return (
    <p class="resume">
      <select
        name="resume"
        aria-label="Stopped workflow"
        value={resumeId}
        onChange={(event) => setResumeId(event.currentTarget.value)}
      >
        {stopped.map((workflow) => (
          <option key={workflow.id} value={workflow.id}>
            {workflow.title}
          </option>
        ))}
      </select>
      <button type="button" class="button button-quiet" onClick={() => onResume(resumeId)}>
        Resume
      </button>
    </p>
  );
}

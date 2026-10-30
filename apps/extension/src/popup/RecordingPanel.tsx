import type { RecordingStatus, Workflow } from "@recnrun/domain";

interface Props {
  workflow: Workflow;
  missingOrigins: RecordingStatus["missingOrigins"];
  onAllow: (origin: string) => void;
  onStop: () => void;
}

export function RecordingPanel({ workflow, missingOrigins, onAllow, onStop }: Props) {
  return (
    <section class="recording" aria-label="Current recording">
      <p>
        <span class="record-dot" aria-hidden="true" /> Recording <strong>{workflow.title}</strong>
      </p>
      {missingOrigins.length > 0 && (
        <p class="hint">Pages on these origins are not recorded until you allow access:</p>
      )}
      {missingOrigins.map((origin) => (
        <button key={origin} type="button" class="button" onClick={() => onAllow(origin)}>
          Allow access to {origin}
        </button>
      ))}
      <button type="button" class="button button-stop" onClick={onStop}>
        Stop
      </button>
    </section>
  );
}

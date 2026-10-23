import logo from "@/assets/logo.svg?raw";
import { formatElapsed } from "@/views/recording";
import type { Recording } from "@/views/recording";

// A data URL needs no base URL, so it loads in the blank PiP document as in the panel frame.
const LOGO_URL = `data:image/svg+xml,${encodeURIComponent(logo)}`;

/** "Recording 00:18" or "Paused 00:18". */
export function RecordStatus({ recording }: { recording: Recording }) {
  return (
    <>
      <strong>{recording.status === "recording" ? "Recording" : "Paused"}</strong>{" "}
      <time>{formatElapsed(recording.seconds)}</time>
    </>
  );
}

/** The session's compact controls, in its Split View pane or its PiP window. */
export function RecordPanel(props: { recording: Recording; onStop: () => void }) {
  const { recording, onStop } = props;
  return (
    <section class="record-panel" aria-label="Recording panel">
      <img class="record-logo" src={LOGO_URL} alt="RECnRun" />
      <p>
        <RecordStatus recording={recording} />
      </p>
      <div class="record-actions">
        <button type="button" onClick={recording.toggle}>
          {recording.status === "recording" ? "Pause" : "Resume"}
        </button>
        <button type="button" onClick={onStop}>
          Stop
        </button>
      </div>
    </section>
  );
}

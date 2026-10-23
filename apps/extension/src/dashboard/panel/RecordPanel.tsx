import { useEffect } from "preact/hooks";
import { formatElapsed, useRecording } from "@/dashboard/panel/recording";
import type { Recording } from "@/dashboard/panel/recording";

/** The compact controls shown in the PiP window, or in the tab when PiP is missing. */
export function RecordPanel(props: { recording: Recording; onStop: () => void }) {
  const { recording, onStop } = props;
  const recordingNow = recording.status === "recording";
  return (
    <section class="record-panel" aria-label="Recording panel">
      <p>
        <strong>{recordingNow ? "Recording" : "Paused"}</strong>{" "}
        <time>{formatElapsed(recording.seconds)}</time>
      </p>
      <div class="record-actions">
        <button type="button" onClick={recording.toggle}>
          {recordingNow ? "Pause" : "Resume"}
        </button>
        <button type="button" onClick={onStop}>
          Stop
        </button>
      </div>
    </section>
  );
}

/** The panel page loaded into a PiP window that the site opened; it owns its own recording. */
export function StandalonePanel(props: { onStop: () => void }) {
  const recording = useRecording();
  const { start } = recording;
  useEffect(start, []);
  if (recording.status === "idle") return null;
  return (
    <RecordPanel
      recording={recording}
      onStop={() => {
        recording.stop();
        props.onStop();
      }}
    />
  );
}

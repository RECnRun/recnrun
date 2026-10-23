import { useEffect } from "preact/hooks";
import { formatElapsed, useEnded, useRecording } from "@/dashboard/panel/recording";
import type { Recording, RecordingStore } from "@/dashboard/panel/recording";
import { useLockHeld } from "@/dashboard/use-lock-held";
import { DASHBOARD_LOCK, holdLock, PANEL_LOCK } from "@/messaging/view-locks";

/** "Recording 00:18" or "Paused 00:18". */
export function RecordStatus({ recording }: { recording: Recording }) {
  return (
    <>
      <strong>{recording.status === "recording" ? "Recording" : "Paused"}</strong>{" "}
      <time>{formatElapsed(recording.seconds)}</time>
    </>
  );
}

/** The compact controls shown in the PiP window, or in the tab when PiP is missing. */
export function RecordPanel(props: { recording: Recording; onStop: () => void }) {
  const { recording, onStop } = props;
  return (
    <section class="record-panel" aria-label="Recording panel">
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

/** The panel page in a PiP window the site opened; it closes when recording ends or moves to the tab. */
export function StandalonePanel(props: { store: RecordingStore; onStop: () => void }) {
  const { store, onStop } = props;
  const recording = useRecording(store);
  const dashboardOpen = useLockHeld(DASHBOARD_LOCK);
  useEffect(() => holdLock(PANEL_LOCK), []);
  // The site's panel gives way once the dashboard tab, which owns recording, opens.
  useEffect(() => {
    if (dashboardOpen) onStop();
  }, [dashboardOpen, onStop]);
  useEnded(recording.status, onStop);
  if (recording.status === "idle") return null;
  return <RecordPanel recording={recording} onStop={recording.stop} />;
}

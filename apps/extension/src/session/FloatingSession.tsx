import { RecordPanel } from "@/views/RecordPanel";
import { useEnded, useRecording } from "@/views/recording";
import type { RecordingStore } from "@/views/recording";

/** The session framed in the PiP window the site opened; it asks to close the window at the end. */
export function FloatingSession(props: { store: RecordingStore; onEnd: () => void }) {
  const recording = useRecording(props.store);
  useEnded(recording.status, props.onEnd);
  // The dashboard starts the session as the window opens, so it can still be idle for a moment.
  if (recording.status === "idle") return null;
  return <RecordPanel recording={recording} />;
}

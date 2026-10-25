import type { RecordingStore } from "@/ports/recording-store";
import type { TabSource } from "@/ports/tabs";
import { SessionTabs } from "@/session/SessionTabs";
import { RecordPanel } from "@/views/RecordPanel";
import { useEnded, useRecording } from "@/views/recording";

interface FloatingSessionProps {
  store: RecordingStore;
  /** The browser's tabs, to show the current and the recorded one. */
  tabs: TabSource;
  onEnd: () => void;
}

/** The session framed in the PiP window the site opened; it asks to close the window at the end. */
export function FloatingSession(props: FloatingSessionProps) {
  const recording = useRecording(props.store);
  useEnded(recording.status, props.onEnd);
  // The dashboard starts the session as the window opens, so it can still be idle for a moment.
  if (recording.status === "idle") return null;
  return (
    <>
      <RecordPanel recording={recording} />
      <SessionTabs source={props.tabs} recordedId={recording.tabId} />
    </>
  );
}

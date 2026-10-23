import { createPortal } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { holdLock, PANEL_LOCK } from "@/messaging/view-locks";
import { copyStyles, requestPanelWindow } from "@/pip/document-pip";
import type { DocumentPictureInPicture } from "@/pip/document-pip";
import type { SessionTab } from "@/session/session-tab";
import { RecordPanel } from "@/views/RecordPanel";
import { errorText, useEnded, useRecording } from "@/views/recording";
import type { RecordingStore } from "@/views/recording";

const DASHBOARD_PATH = "/dashboard.html";

/** Opens a dashboard in a new tab; the session stays where it is. */
function DashboardLink() {
  return (
    <a class="dashboard-link" href={DASHBOARD_PATH} target="_blank" rel="noopener">
      Open the dashboard
    </a>
  );
}

/** What a session page shows when no session runs, as when its address is typed. */
function NoSession() {
  return (
    <main class="session">
      <p role="status">No recording is running.</p>
      <DashboardLink />
    </main>
  );
}

export interface SessionPaneProps {
  store: RecordingStore;
  tab: SessionTab;
  /** The page's PiP API; without it the session cannot float. */
  pip?: DocumentPictureInPicture;
}

/** The session in its Split View pane, which can float it in a PiP window and closes when it ends. */
export function SessionPane({ store, tab, pip }: SessionPaneProps) {
  const recording = useRecording(store);
  const [panel, setPanel] = useState<Window>();
  const [error, setError] = useState<string>();
  const ended = useRef(false);
  useEnded(recording.status, () => {
    ended.current = true;
    panel?.close();
    void tab.close();
  });
  useEffect(() => (panel ? holdLock(PANEL_LOCK) : undefined), [panel]);

  const float = (opener: DocumentPictureInPicture) => {
    // Nothing may await before this call, or Chrome refuses it for lack of user activation.
    requestPanelWindow(opener).then(
      (opened) => {
        copyStyles(document, opened.document);
        opened.addEventListener("pagehide", () => {
          setPanel(undefined);
          // Closing the window without Stop brings the session back beside its page.
          if (!ended.current) void tab.focus();
        });
        setPanel(opened);
        setError(undefined);
        void tab.leaveSplit();
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };

  if (!recording.loaded) return null;
  if (recording.status === "idle") return <NoSession />;
  const controls = <RecordPanel recording={recording} onStop={recording.stop} />;
  return (
    <main class="session">
      {panel ? createPortal(controls, panel.document.body) : controls}
      {panel && <p>The session floats in its own window.</p>}
      {pip && !panel && (
        <button type="button" onClick={() => float(pip)}>
          Float
        </button>
      )}
      {(error ?? recording.error) && <p role="alert">{error ?? recording.error}</p>}
      <DashboardLink />
    </main>
  );
}

/** The session framed in a PiP window that a dashboard or the site opened; it asks to close at the end. */
export function FloatingSession(props: { store: RecordingStore; onEnd: () => void }) {
  const recording = useRecording(props.store);
  useEffect(() => holdLock(PANEL_LOCK), []);
  useEnded(recording.status, props.onEnd);
  // The opener starts the session as the window opens, so it can still be idle for a moment.
  if (recording.status === "idle") return null;
  return <RecordPanel recording={recording} onStop={recording.stop} />;
}

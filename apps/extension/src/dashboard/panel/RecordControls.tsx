import { createPortal } from "preact/compat";
import { useState } from "preact/hooks";
import { RecordPanel } from "@/dashboard/panel/RecordPanel";
import { useRecording } from "@/dashboard/panel/recording";
import { copyStyles, requestPanelWindow } from "@/pip/document-pip";
import type { DocumentPictureInPicture } from "@/pip/document-pip";

/** Where the recording panel shows, decided by where the dashboard runs. */
export type RecordSurface =
  | { kind: "window"; pip: DocumentPictureInPicture; focusTab: () => Promise<void> }
  | { kind: "parent"; requestPanel: () => void }
  | { kind: "inline" };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function RecordButton(props: { label?: string; onClick: () => void }) {
  return (
    <button type="button" class="record-button" onClick={props.onClick}>
      {props.label ?? "Record"}
    </button>
  );
}

/** A top-level dashboard renders the panel into its own PiP window, sharing its state. */
function WindowControls(props: { pip: DocumentPictureInPicture; focusTab: () => Promise<void> }) {
  const recording = useRecording();
  const [panel, setPanel] = useState<Window>();
  const [error, setError] = useState<string>();

  const showPanel = (onOpen?: () => void) => {
    // Nothing may await before this call, or Chrome refuses it for lack of user activation.
    requestPanelWindow(props.pip).then(
      (opened) => {
        copyStyles(document, opened.document);
        opened.addEventListener("pagehide", () => setPanel(undefined));
        setPanel(opened);
        setError(undefined);
        onOpen?.();
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  const stop = () => {
    recording.stop();
    panel?.close();
    void props.focusTab();
  };

  if (recording.status === "idle") {
    return (
      <>
        <RecordButton onClick={() => showPanel(recording.start)} />
        {error && <p role="alert">{error}</p>}
      </>
    );
  }
  if (panel)
    return createPortal(<RecordPanel recording={recording} onStop={stop} />, panel.document.body);
  return <ClosedPanel onShow={() => showPanel()} onStop={stop} />;
}

function ClosedPanel(props: { onShow: () => void; onStop: () => void }) {
  return (
    <div class="record-status">
      <p role="status">The panel is closed. Recording continues.</p>
      <RecordButton label="Show the panel" onClick={props.onShow} />
      <button type="button" onClick={props.onStop}>
        Stop
      </button>
    </div>
  );
}

/** Without Document PiP, the controls stay in the tab and do not float over other tabs. */
function InlineControls() {
  const recording = useRecording();
  if (recording.status === "idle") return <RecordButton onClick={recording.start} />;
  return <RecordPanel recording={recording} onStop={recording.stop} />;
}

export function RecordControls({ surface }: { surface: RecordSurface }) {
  switch (surface.kind) {
    case "window":
      return <WindowControls pip={surface.pip} focusTab={surface.focusTab} />;
    case "parent":
      return <RecordButton onClick={surface.requestPanel} />;
    case "inline":
      return <InlineControls />;
  }
}

import { createPortal } from "preact/compat";
import { useState } from "preact/hooks";
import { RecordPanel, RecordStatus } from "@/dashboard/panel/RecordPanel";
import { errorText, useEnded, useRecording } from "@/dashboard/panel/recording";
import type { Recording, RecordingStore } from "@/dashboard/panel/recording";
import { copyStyles, requestPanelWindow } from "@/pip/document-pip";
import type { DocumentPictureInPicture } from "@/pip/document-pip";

/** Where the recording panel shows, decided by where the dashboard runs. */
export type RecordSurface =
  | { kind: "window"; pip: DocumentPictureInPicture; focusTab: () => Promise<void> }
  | { kind: "parent"; requestPanel: () => void }
  | { kind: "inline" };

/** The panel's surface and the recording every view shares. */
export interface RecordSetup {
  surface: RecordSurface;
  store: RecordingStore;
}

function RecordButton(props: { label?: string; onClick: () => void }) {
  return (
    <button type="button" class="record-button" onClick={props.onClick}>
      {props.label ?? "Record"}
    </button>
  );
}

function IdleControls(props: { onRecord: () => void; error?: string }) {
  return (
    <>
      <RecordButton onClick={props.onRecord} />
      {props.error && <p role="alert">{props.error}</p>}
    </>
  );
}

/** A recording runs while its panel is elsewhere: closed, or in another view's PiP window. */
function InProgress(props: { recording: Recording; onShow: () => void; onStop: () => void }) {
  return (
    <div class="record-status">
      <p>
        <RecordStatus recording={props.recording} />
      </p>
      <RecordButton label="Show the panel" onClick={props.onShow} />
      <button type="button" onClick={props.onStop}>
        Stop
      </button>
    </div>
  );
}

/** A top-level dashboard renders the panel into its own PiP window. */
function WindowControls(props: {
  pip: DocumentPictureInPicture;
  focusTab: () => Promise<void>;
  store: RecordingStore;
}) {
  const recording = useRecording(props.store);
  const [panel, setPanel] = useState<Window>();
  const [error, setError] = useState<string>();
  useEnded(recording.status, () => panel?.close());

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
      <IdleControls onRecord={() => showPanel(recording.start)} error={error ?? recording.error} />
    );
  }
  if (panel)
    return createPortal(<RecordPanel recording={recording} onStop={stop} />, panel.document.body);
  return <InProgress recording={recording} onShow={() => showPanel()} onStop={stop} />;
}

/** A framed dashboard asks the site to open the panel, which runs in a frame of its own. */
function ParentControls(props: { requestPanel: () => void; store: RecordingStore }) {
  const { requestPanel } = props;
  const recording = useRecording(props.store);
  if (recording.status === "idle") {
    const record = () => {
      requestPanel();
      recording.start();
    };
    return <IdleControls onRecord={record} error={recording.error} />;
  }
  return <InProgress recording={recording} onShow={requestPanel} onStop={recording.stop} />;
}

/** Without Document PiP, the controls stay in the tab and do not float over other tabs. */
function InlineControls(props: { store: RecordingStore }) {
  const recording = useRecording(props.store);
  if (recording.status === "idle") {
    return <IdleControls onRecord={recording.start} error={recording.error} />;
  }
  return <RecordPanel recording={recording} onStop={recording.stop} />;
}

export function RecordControls({ surface, store }: RecordSetup) {
  switch (surface.kind) {
    case "window":
      return <WindowControls pip={surface.pip} focusTab={surface.focusTab} store={store} />;
    case "parent":
      return <ParentControls requestPanel={surface.requestPanel} store={store} />;
    case "inline":
      return <InlineControls store={store} />;
  }
}

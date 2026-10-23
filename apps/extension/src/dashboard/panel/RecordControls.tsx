import { createPortal } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { RecordPanel, RecordStatus } from "@/dashboard/panel/RecordPanel";
import { errorText, useEnded, useRecording } from "@/dashboard/panel/recording";
import type { Recording, RecordingStore } from "@/dashboard/panel/recording";
import type { PanelTab } from "@/dashboard/panel/panel-tab";
import { copyStyles, requestPanelWindow } from "@/pip/document-pip";
import { useLockHeld } from "@/dashboard/use-lock-held";
import { DASHBOARD_LOCK, holdLock, PANEL_LOCK } from "@/messaging/view-locks";
import type { DocumentPictureInPicture } from "@/pip/document-pip";

/** Where the recording panel shows, decided by where the dashboard runs. */
export type RecordSurface =
  | { kind: "window"; pip: DocumentPictureInPicture; tab: PanelTab }
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
  // Opening a second PiP window would close the open one, wherever it is.
  const panelOpen = useLockHeld(PANEL_LOCK);
  return (
    <div class="record-status">
      <p>
        <RecordStatus recording={props.recording} />
      </p>
      {panelOpen ? (
        <p>The panel is open in a floating window.</p>
      ) : (
        <RecordButton label="Show the panel" onClick={props.onShow} />
      )}
      <button type="button" onClick={props.onStop}>
        Stop
      </button>
    </div>
  );
}

/** A top-level dashboard renders the panel into its own PiP window and steps out of a Split View. */
function WindowControls(props: {
  pip: DocumentPictureInPicture;
  tab: PanelTab;
  store: RecordingStore;
}) {
  const recording = useRecording(props.store);
  const [panel, setPanel] = useState<Window>();
  const [error, setError] = useState<string>();
  useEnded(recording.status, () => panel?.close());
  useEffect(() => (panel ? holdLock(PANEL_LOCK) : undefined), [panel]);

  const showPanel = (onOpen?: () => void) => {
    // Nothing may await before this call, or Chrome refuses it for lack of user activation.
    requestPanelWindow(props.pip).then(
      (opened) => {
        copyStyles(document, opened.document);
        opened.addEventListener("pagehide", () => setPanel(undefined));
        setPanel(opened);
        setError(undefined);
        onOpen?.();
        void props.tab.leaveSplit();
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  const stop = () => {
    recording.stop();
    panel?.close();
    void props.tab.focus();
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

/** The site's framed dashboard leaves recording to the dashboard tab while that tab is open. */
function DeferredControls({ recording }: { recording: Recording }) {
  return (
    <div class="record-status">
      {recording.status !== "idle" && (
        <p>
          <RecordStatus recording={recording} />
        </p>
      )}
      <p>Recording is controlled from the RECnRun tab.</p>
    </div>
  );
}

/** A framed dashboard asks the site to open the panel, which runs in a frame of its own. */
function ParentControls(props: { requestPanel: () => void; store: RecordingStore }) {
  const { requestPanel } = props;
  const recording = useRecording(props.store);
  const dashboardOpen = useLockHeld(DASHBOARD_LOCK);
  if (dashboardOpen) return <DeferredControls recording={recording} />;
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
      return <WindowControls pip={surface.pip} tab={surface.tab} store={store} />;
    case "parent":
      return <ParentControls requestPanel={surface.requestPanel} store={store} />;
    case "inline":
      return <InlineControls store={store} />;
  }
}

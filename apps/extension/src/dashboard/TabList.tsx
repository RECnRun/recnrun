import { useEffect, useState } from "preact/hooks";
import type { OpenTab, TabSource } from "@/dashboard/open-tabs";
import { PANEL_LOCK } from "@/messaging/view-locks";
import { RecordStatus } from "@/views/RecordPanel";
import { errorText, useRecording } from "@/views/recording";
import type { Recording, RecordingStore } from "@/views/recording";
import { useLockHeld } from "@/views/use-lock-held";

/** How a dashboard starts the session on a tab. */
export interface SessionActions {
  /** Records the tab with the session's pane beside it in a Split View. */
  record: (tabId: number) => void;
  /** Records the tab with the session in a PiP window; absent without Document PiP. */
  float?: (tabId: number) => Promise<void>;
}

/** The browser's tabs and the one session, which a dashboard shows and starts. */
export interface SessionSetup {
  tabs: TabSource;
  store: RecordingStore;
  actions: SessionActions;
}

function useOpenTabs(source: TabSource): OpenTab[] {
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  useEffect(() => {
    const refresh = () => void source.list().then(setTabs);
    refresh();
    return source.watch(refresh);
  }, [source]);
  return tabs;
}

/** The session's controls on the tab it records. */
function SessionControls(props: { tab: OpenTab; recording: Recording; actions: SessionActions }) {
  const { tab, recording, actions } = props;
  // Showing the pane would bring back what the floating session keeps out of the way.
  const floating = useLockHeld(PANEL_LOCK);
  return (
    <>
      <p>
        <RecordStatus recording={recording} />
      </p>
      {floating ? (
        <p>The session floats in its own window.</p>
      ) : (
        <button type="button" onClick={() => actions.record(tab.id)}>
          Show
        </button>
      )}
      <button type="button" onClick={recording.toggle}>
        {recording.status === "recording" ? "Pause" : "Resume"}
      </button>
      <button type="button" onClick={recording.stop}>
        Stop
      </button>
    </>
  );
}

function StartControls(props: { tab: OpenTab; actions: SessionActions }) {
  const { tab, actions } = props;
  const { float } = actions;
  const [error, setError] = useState<string>();
  return (
    <>
      <button type="button" class="record-button" onClick={() => actions.record(tab.id)}>
        Record
      </button>
      {float && (
        <button
          type="button"
          onClick={() => void float(tab.id).catch((caught: unknown) => setError(errorText(caught)))}
        >
          Float
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}

function TabItem(props: { tab: OpenTab; recording: Recording; actions: SessionActions }) {
  const { tab, recording, actions } = props;
  const recorded = recording.status !== "idle" && recording.tabId === tab.id;
  return (
    <li class="tab" aria-label={tab.title}>
      <span class="tab-title">{tab.title}</span>
      <span class="tab-url">{tab.url}</span>
      <div class="tab-actions">
        {recorded && <SessionControls tab={tab} recording={recording} actions={actions} />}
        {recording.loaded && recording.status === "idle" && (
          <StartControls tab={tab} actions={actions} />
        )}
      </div>
    </li>
  );
}

/** Every open tab; with no session, each can start one, and the recorded tab controls it. */
export function TabList({ tabs, store, actions }: SessionSetup) {
  const openTabs = useOpenTabs(tabs);
  const recording = useRecording(store);
  return (
    <aside class="tabs" aria-labelledby="tabs-heading">
      <h2 id="tabs-heading">Tabs</h2>
      <ul>
        {openTabs.map((tab) => (
          <TabItem key={tab.id} tab={tab} recording={recording} actions={actions} />
        ))}
      </ul>
      {recording.error && <p role="alert">{recording.error}</p>}
    </aside>
  );
}

import { useEffect, useState } from "preact/hooks";
import type { OpenTab, TabSource } from "@/dashboard/open-tabs";
import { CONTROL_LOCK } from "@/messaging/view-locks";
import { RecordStatus } from "@/views/RecordPanel";
import { errorText, useRecording } from "@/views/recording";
import type { Recording, RecordingStore } from "@/views/recording";
import { useLockHeld } from "@/views/use-lock-held";

/**
 * Takes the control of the session for this dashboard and floats it in a PiP window: it records
 * the tab when no session runs, or continues the one that does. It rejects while another
 * dashboard has the control.
 */
export type TakeControl = (tabId: number) => Promise<void>;

/** The browser's tabs and the one session, which a dashboard shows and starts. */
export interface SessionSetup {
  tabs: TabSource;
  store: RecordingStore;
  take: TakeControl;
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

interface TabProps {
  tab: OpenTab;
  recording: Recording;
  /** Whether a dashboard has the control, so the session floats in its PiP window. */
  controlled: boolean;
  take: () => void;
}

/** The session on the tab it records; its controls are in the PiP window while one is open. */
function SessionControls({ recording, controlled, take }: Omit<TabProps, "tab">) {
  return (
    <>
      <p>
        <RecordStatus recording={recording} />
      </p>
      {controlled ? (
        <p>The session floats in its own window.</p>
      ) : (
        <>
          <button type="button" onClick={take}>
            Continue
          </button>
          <button type="button" onClick={recording.stop}>
            Stop
          </button>
        </>
      )}
    </>
  );
}

function TabItem({ tab, recording, controlled, take }: TabProps) {
  const recorded = recording.status !== "idle" && recording.tabId === tab.id;
  const idle = recording.loaded && recording.status === "idle" && !controlled;
  return (
    <li class="tab" aria-label={tab.title}>
      <span class="tab-title">{tab.title}</span>
      <span class="tab-url">{tab.url}</span>
      <div class="tab-actions">
        {recorded && <SessionControls recording={recording} controlled={controlled} take={take} />}
        {idle && (
          <button type="button" class="record-button" onClick={take}>
            Record
          </button>
        )}
      </div>
    </li>
  );
}

/** Every open tab; with no session each can start one, and the recorded tab shows the session. */
export function TabList({ tabs, store, take }: SessionSetup) {
  const openTabs = useOpenTabs(tabs);
  const recording = useRecording(store);
  const controlled = useLockHeld(CONTROL_LOCK);
  const [error, setError] = useState<string>();
  const takeOn = (tabId: number) => () => {
    setError(undefined);
    take(tabId).catch((caught: unknown) => setError(errorText(caught)));
  };
  return (
    <aside class="tabs" aria-labelledby="tabs-heading">
      <h2 id="tabs-heading">Tabs</h2>
      <ul>
        {openTabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            recording={recording}
            controlled={controlled}
            take={takeOn(tab.id)}
          />
        ))}
      </ul>
      {(error ?? recording.error) && <p role="alert">{error ?? recording.error}</p>}
    </aside>
  );
}

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

/** The open tabs, or `undefined` until they are first listed. */
function useOpenTabs(source: TabSource): OpenTab[] | undefined {
  const [tabs, setTabs] = useState<OpenTab[]>();
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

/**
 * The session on the tab it records; its controls are in the PiP window while one is open. With
 * no `take`, as when the recorded tab closed, the session can only be stopped.
 */
function SessionControls({
  recording,
  controlled,
  take,
}: Omit<TabProps, "tab" | "take"> & { take?: () => void }) {
  return (
    <>
      <p>
        <RecordStatus recording={recording} />
      </p>
      {controlled ? (
        <p>The session floats in its own window.</p>
      ) : (
        <>
          {take && (
            <button type="button" onClick={take}>
              Continue
            </button>
          )}
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

/** The session outlives the tab it records, which only an explicit Stop ends. */
function ClosedTabItem({ recording, controlled }: Omit<TabProps, "tab" | "take">) {
  return (
    <li class="tab" aria-label="Closed tab">
      <span class="tab-title">Closed tab</span>
      <span class="tab-url">The tab this session records was closed.</span>
      <div class="tab-actions">
        <SessionControls recording={recording} controlled={controlled} />
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
  const closed =
    openTabs !== undefined &&
    recording.status !== "idle" &&
    !openTabs.some((tab) => tab.id === recording.tabId);
  const takeOn = (tabId: number) => () => {
    setError(undefined);
    take(tabId).catch((caught: unknown) => setError(errorText(caught)));
  };
  return (
    <aside class="tabs" aria-labelledby="tabs-heading">
      <h2 id="tabs-heading">Tabs</h2>
      <ul>
        {openTabs?.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            recording={recording}
            controlled={controlled}
            take={takeOn(tab.id)}
          />
        ))}
        {closed && <ClosedTabItem recording={recording} controlled={controlled} />}
      </ul>
      {(error ?? recording.error) && <p role="alert">{error ?? recording.error}</p>}
    </aside>
  );
}

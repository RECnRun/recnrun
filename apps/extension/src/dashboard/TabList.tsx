import { errorMessage } from "@recnrun/domain";
import { useState } from "preact/hooks";
import type { RecordingStore } from "@/ports/recording-store";
import type { OpenTab, TabSource } from "@/ports/tabs";
import { RecordStatus } from "@/views/RecordPanel";
import { useRecording } from "@/views/recording";
import type { Recording } from "@/views/recording";
import { TabSummary } from "@/views/TabSummary";
import { useBrowserTabs } from "@/views/use-browser-tabs";
import { CONTROL_LOCK } from "@/views/view-locks";
import { useLockHeld } from "@/views/use-lock-held";

/**
 * Takes the control of the session for this dashboard and floats it in a PiP window: it records
 * the tab when no session runs, or continues the one that does. It rejects while another
 * dashboard has the control.
 */
export type TakeControl = (tabId: number) => Promise<void>;

/** The browser's tabs and the one session, which a dashboard shows and starts. */
interface TabListProps {
  tabs: TabSource;
  store: RecordingStore;
  take: TakeControl;
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
      <TabSummary tab={tab} />
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
export function TabList({ tabs, store, take }: TabListProps) {
  const openTabs = useBrowserTabs(tabs)?.tabs;
  const recording = useRecording(store);
  const controlled = useLockHeld(CONTROL_LOCK);
  const [error, setError] = useState<string>();
  const closed =
    openTabs !== undefined &&
    recording.status !== "idle" &&
    !openTabs.some((tab) => tab.id === recording.tabId);
  const takeOn = (tabId: number) => () => {
    setError(undefined);
    take(tabId).catch((caught: unknown) => setError(errorMessage(caught)));
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

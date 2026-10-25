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
  /** Which browser profile the tabs belong to, when the dashboard lists two. */
  heading?: { id: string; text: string };
  /** Brings a tab to the front, for tabs of another profile, whose window is out of sight. */
  activate?: (tabId: number) => Promise<void>;
  /** Why the list can neither start nor change a session, shown in place of those buttons. */
  blocked?: string;
}

interface TabProps {
  tab: OpenTab;
  recording: Recording;
  /** Whether a dashboard has the control, so the session floats in its PiP window. */
  controlled: boolean;
  blocked: boolean;
  take: () => void;
  show?: () => void;
}

/**
 * The session on the tab it records; its controls are in the PiP window while one is open. With
 * no `take`, as when the recorded tab closed, the session can only be stopped; blocked, it has
 * no controls here.
 */
function SessionControls({
  recording,
  controlled,
  blocked,
  take,
}: Omit<TabProps, "tab" | "take"> & { take?: () => void }) {
  const status = (
    <p>
      <RecordStatus recording={recording} />
    </p>
  );
  if (blocked) return status;
  return (
    <>
      {status}
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

function TabItem({ tab, recording, controlled, blocked, take, show }: TabProps) {
  const recorded = recording.status !== "idle" && recording.tabId === tab.id;
  const idle = recording.loaded && recording.status === "idle" && !controlled && !blocked;
  return (
    <li class="tab" aria-label={tab.title}>
      <TabSummary tab={tab} />
      <div class="tab-actions">
        {recorded && (
          <SessionControls
            recording={recording}
            controlled={controlled}
            blocked={blocked}
            take={take}
          />
        )}
        {idle && (
          <button type="button" class="record-button" onClick={take}>
            Record
          </button>
        )}
        {show && (
          <button type="button" onClick={show}>
            Show tab
          </button>
        )}
      </div>
    </li>
  );
}

/** The session outlives the tab it records, which only an explicit Stop ends. */
function ClosedTabItem({
  recording,
  controlled,
  blocked,
}: Omit<TabProps, "tab" | "take" | "show">) {
  return (
    <li class="tab" aria-label="Closed tab">
      <span class="tab-title">Closed tab</span>
      <span class="tab-url">The tab this session records was closed.</span>
      <div class="tab-actions">
        <SessionControls recording={recording} controlled={controlled} blocked={blocked} />
      </div>
    </li>
  );
}

/** Every open tab; with no session each can start one, and the recorded tab shows the session. */
function recordedTabClosed(openTabs: OpenTab[] | undefined, recording: Recording): boolean {
  if (openTabs === undefined || recording.status === "idle") return false;
  return !openTabs.some((tab) => tab.id === recording.tabId);
}

const LOCAL_HEADING = { id: "tabs-heading", text: "Tabs" };

export function TabList(props: TabListProps) {
  const { tabs, store, take, heading = LOCAL_HEADING, activate, blocked } = props;
  const openTabs = useBrowserTabs(tabs)?.tabs;
  const recording = useRecording(store);
  const controlled = useLockHeld(CONTROL_LOCK);
  const [error, setError] = useState<string>();
  const closed = recordedTabClosed(openTabs, recording);
  const attempt = (action: (tabId: number) => Promise<void>) => (tabId: number) => () => {
    setError(undefined);
    action(tabId).catch((caught: unknown) => setError(errorMessage(caught)));
  };
  const takeOn = attempt(take);
  const showOn = activate && attempt(activate);
  return (
    <aside class="tabs" aria-labelledby={heading.id}>
      <h2 id={heading.id}>{heading.text}</h2>
      {blocked && <p class="tab-note">{blocked}</p>}
      <ul>
        {openTabs?.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            recording={recording}
            controlled={controlled}
            blocked={blocked !== undefined}
            take={takeOn(tab.id)}
            show={showOn?.(tab.id)}
          />
        ))}
        {closed && (
          <ClosedTabItem
            recording={recording}
            controlled={controlled}
            blocked={blocked !== undefined}
          />
        )}
      </ul>
      {(error ?? recording.error) && <p role="alert">{error ?? recording.error}</p>}
    </aside>
  );
}

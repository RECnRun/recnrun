import { useRef } from "preact/hooks";
import type { TabSource } from "@/ports/tabs";
import { currentTab } from "@/tabs/open-tabs";
import { TabSummary } from "@/views/TabSummary";
import { useBrowserTabs } from "@/views/use-browser-tabs";

/**
 * The tab in focus, and the recorded tab when the focus is elsewhere: switching tabs only changes
 * what this shows, never which tab the session records.
 */
export function SessionTabs({ source, recordedId }: { source: TabSource; recordedId?: number }) {
  const state = useBrowserTabs(source);
  const lastId = useRef<number | undefined>(undefined);
  if (!state) return null;
  const { tab, focused } = currentTab(state, lastId.current);
  lastId.current = tab?.id;
  const recorded = state.tabs.find((each) => each.id === recordedId);
  const badges = [
    ...(tab?.id === recordedId ? ["Recorded"] : []),
    ...(focused ? [] : ["Not in focus"]),
  ];
  return (
    <div class="session-tabs">
      <section class="session-tab" aria-label="Current tab">
        <h2>Current tab</h2>
        {tab ? <TabSummary tab={tab} badges={badges} /> : <p>No tab in focus.</p>}
      </section>
      {tab?.id !== recordedId && (
        <section class="session-tab" aria-label="Recorded tab">
          <h2>Recorded tab</h2>
          {recorded ? <TabSummary tab={recorded} /> : <p>The recorded tab was closed.</p>}
        </section>
      )}
    </div>
  );
}

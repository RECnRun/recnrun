import type { Snapshot } from "@recnrun/domain";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { disallowedAncestor } from "@/config/origins";
import { Dashboard, Refusal } from "@/dashboard/Dashboard";
import type { DashboardTab } from "@/dashboard/dashboard-tab";
import { panelTab } from "@/dashboard/panel/panel-tab";
import type { RecordSurface } from "@/dashboard/panel/RecordControls";
import { StandalonePanel } from "@/dashboard/panel/RecordPanel";
import type { RecordingStore } from "@/dashboard/panel/recording";
import { createFrameRouter, createHashRouter } from "@/dashboard/router";
import { workspaceParam } from "@/dashboard/workspace";
import { workspaceSearch } from "@/messaging/dashboard-protocol";
import { DASHBOARD_LOCK, holdLock } from "@/messaging/view-locks";
import { closePanelMessage, openPanelMessage } from "@/messaging/frame-protocol";
import { documentPip } from "@/pip/document-pip";

/** What the dashboard reads and shares, injected so tests need no extension storage. */
export interface DashboardData {
  loadSnapshot: () => Promise<Snapshot>;
  recordings: RecordingStore;
  /** The top-level dashboard's tab, absent where tests run without the extension APIs. */
  tab?: DashboardTab;
}

const isPanelView = (search: string) => new URLSearchParams(search).get("view") === "panel";

/** A top-level page opens its own PiP window; without the API the controls stay in the tab. */
function topLevelSurface(page: Window): RecordSurface {
  const pip = documentPip(page);
  return pip ? { kind: "window", pip, tab: panelTab() } : { kind: "inline" };
}

/** A dashboard tab, which follows the page the background moves it beside. */
function TopLevelDashboard({ data, page }: { data: DashboardData; page: Window }) {
  const [router] = useState(() => createHashRouter(page));
  const [surface] = useState(() => topLevelSurface(page));
  // A Split View tab opens with the workspace of the page beside it.
  const [workspace, setWorkspace] = useState(() => workspaceParam(page.location.search));
  useEffect(() => holdLock(DASHBOARD_LOCK), []);
  useEffect(() => {
    void data.tab?.yieldToEarlier(new URL(page.location.href));
    return data.tab?.onShowWorkspace((next) => {
      setWorkspace(next);
      // A reload keeps the workspace; navigating now would reload and close the PiP panel.
      const { pathname, hash } = page.location;
      page.history.replaceState(null, "", pathname + workspaceSearch(next) + hash);
    });
  }, [data, page]);
  return (
    <Dashboard
      loadSnapshot={data.loadSnapshot}
      router={router}
      workspace={workspace}
      record={{ surface, store: data.recordings }}
    />
  );
}

function startFramed(root: HTMLElement, data: DashboardData, page: Window) {
  const parent = page.location.ancestorOrigins[0] ?? "";
  // The site's content script loads this view into the PiP window it opens.
  if (isPanelView(page.location.search)) {
    const close = () => page.parent.postMessage(closePanelMessage(), parent);
    render(<StandalonePanel store={data.recordings} onStop={close} />, root);
    return;
  }
  // A frame cannot open a PiP window, so it asks the top-level site to.
  const requestPanel = () => page.parent.postMessage(openPanelMessage(), parent);
  render(
    <Dashboard
      loadSnapshot={data.loadSnapshot}
      router={createFrameRouter(parent, page)}
      record={{ surface: { kind: "parent", requestPanel }, store: data.recordings }}
    />,
    root,
  );
}

export function startDashboard(
  root: HTMLElement,
  data: DashboardData,
  page: Window = window,
): void {
  const ancestors = [...page.location.ancestorOrigins];
  // A page framing recnrun.com could clickjack the dashboard, so any foreign ancestor stops it.
  const blocked = disallowedAncestor(ancestors, import.meta.env.MODE);
  if (blocked !== undefined) {
    render(<Refusal origin={blocked} />, root);
    return;
  }
  if (ancestors.length > 0) {
    startFramed(root, data, page);
    return;
  }
  render(<TopLevelDashboard data={data} page={page} />, root);
}

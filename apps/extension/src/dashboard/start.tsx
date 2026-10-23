import type { Snapshot } from "@recnrun/domain";
import { render } from "preact";
import { disallowedAncestor } from "@/config/origins";
import { Dashboard, Refusal } from "@/dashboard/Dashboard";
import { panelTab } from "@/dashboard/panel/panel-tab";
import type { RecordSurface } from "@/dashboard/panel/RecordControls";
import { StandalonePanel } from "@/dashboard/panel/RecordPanel";
import type { RecordingStore } from "@/dashboard/panel/recording";
import { createFrameRouter, createHashRouter } from "@/dashboard/router";
import { workspaceParam } from "@/dashboard/workspace";
import { closePanelMessage, openPanelMessage } from "@/messaging/frame-protocol";
import { documentPip } from "@/pip/document-pip";

/** What the dashboard reads and shares, injected so tests need no extension storage. */
export interface DashboardData {
  loadSnapshot: () => Promise<Snapshot>;
  recordings: RecordingStore;
}

const isPanelView = (search: string) => new URLSearchParams(search).get("view") === "panel";

/** A top-level page opens its own PiP window; without the API the controls stay in the tab. */
function topLevelSurface(page: Window): RecordSurface {
  const pip = documentPip(page);
  return pip ? { kind: "window", pip, tab: panelTab() } : { kind: "inline" };
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
  // A Split View tab opens with the workspace of the page beside it.
  const workspace = workspaceParam(page.location.search);
  render(
    <Dashboard
      loadSnapshot={data.loadSnapshot}
      router={createHashRouter(page)}
      workspace={workspace}
      record={{ surface: topLevelSurface(page), store: data.recordings }}
    />,
    root,
  );
}

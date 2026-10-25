import type { Snapshot } from "@recnrun/domain";
import { controlFrom } from "@/dashboard/control";
import type { SendRequest } from "@/dashboard/control";
import { Dashboard } from "@/dashboard/Dashboard";
import { createFrameRouter } from "@/dashboard/router";
import type { IncognitoAccess, TabSource } from "@/tabs/open-tabs";
import { renderFramed } from "@/views/framed";
import type { RecordingStore } from "@/views/recording";

/** What the dashboard reads and does, injected so tests need no extension APIs. */
export interface DashboardData {
  loadSnapshot: () => Promise<Snapshot>;
  recordings: RecordingStore;
  /** The browser's tabs; without them the dashboard lists no tab to record. */
  tabs?: TabSource;
  incognito?: IncognitoAccess;
  /** Keeps the site tabs' ports open, so a site tab learns when RECnRun unloads. */
  holdSitePorts?: () => void;
  send: SendRequest;
}

export function startDashboard(
  root: HTMLElement,
  data: DashboardData,
  page: Window = window,
): void {
  // The site is the only way in: it frames the dashboard and opens the session's PiP window.
  renderFramed(root, page, import.meta.env.MODE, (parent) => {
    data.holdSitePorts?.();
    const session = data.tabs && {
      tabs: data.tabs,
      store: data.recordings,
      take: controlFrom(page, parent, data.send),
      incognito: data.incognito,
    };
    return (
      <Dashboard
        loadSnapshot={data.loadSnapshot}
        router={createFrameRouter(parent, page)}
        session={session}
      />
    );
  });
}

import type { Snapshot } from "@recnrun/domain";
import { render } from "preact";
import * as v from "valibot";
import { disallowedAncestor } from "@/config/origins";
import { Dashboard } from "@/dashboard/Dashboard";
import { createFrameRouter } from "@/dashboard/router";
import type { TakeControl } from "@/dashboard/TabList";
import { openPanelMessage, PanelClosedMessageSchema } from "@/messaging/frame-protocol";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import { CONTROL_LOCK, tryHoldLock } from "@/messaging/view-locks";
import type { IncognitoAccess, TabSource } from "@/tabs/open-tabs";
import type { RecordingStore } from "@/views/recording";
import { Refusal, SiteOnly } from "@/views/Refusal";

/** What the dashboard reads and does, injected so tests need no extension APIs. */
export interface DashboardData {
  loadSnapshot: () => Promise<Snapshot>;
  recordings: RecordingStore;
  /** The browser's tabs; without them the dashboard lists no tab to record. */
  tabs?: TabSource;
  incognito?: IncognitoAccess;
  /** Sends a session request to the background. */
  send: (request: SessionRequest) => void;
}

const CONTROLLED_ELSEWHERE = "Another RECnRun tab controls the session.";

/**
 * The control lock, taken atomically across every dashboard, makes this one the only one with a
 * PiP window. A frame cannot open that window, so the site's content script opens it, and says
 * when it closes; the lock then frees, and the site tab gets the focus back.
 */
function controlFrom(page: Window, parent: string, send: DashboardData["send"]): TakeControl {
  let release: (() => void) | undefined;
  page.addEventListener("message", (event) => {
    if (event.source !== page.parent || event.origin !== parent) return;
    if (!release || !v.is(PanelClosedMessageSchema, event.data)) return;
    release();
    release = undefined;
    send(returnToDashboardMessage());
  });
  return async (tabId) => {
    if (release) return;
    release = await tryHoldLock(CONTROL_LOCK);
    if (!release) throw new Error(CONTROLLED_ELSEWHERE);
    page.parent.postMessage(openPanelMessage(), parent);
    send(startSessionMessage(tabId));
  };
}

function startFramed(root: HTMLElement, data: DashboardData, page: Window) {
  const parent = page.location.ancestorOrigins[0] ?? "";
  const session = data.tabs && {
    tabs: data.tabs,
    store: data.recordings,
    take: controlFrom(page, parent, data.send),
    incognito: data.incognito,
  };
  render(
    <Dashboard
      loadSnapshot={data.loadSnapshot}
      router={createFrameRouter(parent, page)}
      session={session}
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
  // The site is the only way in: it frames the dashboard and opens the session's PiP window.
  if (ancestors.length === 0) {
    render(<SiteOnly />, root);
    return;
  }
  startFramed(root, data, page);
}

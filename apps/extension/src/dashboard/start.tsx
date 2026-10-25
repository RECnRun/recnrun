import type { Snapshot } from "@recnrun/domain";
import { render } from "preact";
import * as v from "valibot";
import { disallowedAncestor } from "@/config/origins";
import { Dashboard } from "@/dashboard/Dashboard";
import { createFrameRouter } from "@/dashboard/router";
import type { TakeControl } from "@/dashboard/TabList";
import { BackgroundReplySchema } from "@/messaging/background-messages";
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
  /** Keeps the site tabs' ports open, so a site tab learns when RECnRun unloads. */
  holdSitePorts?: () => void;
  /** Sends a session request to the background and resolves with its reply, validated here. */
  send: (request: SessionRequest) => Promise<unknown>;
}

const CONTROLLED_ELSEWHERE = "Another RECnRun tab controls the session.";

/** Rejects with the background's error, or when the reply is not one. */
async function ask(send: DashboardData["send"], request: SessionRequest): Promise<void> {
  const reply = v.parse(BackgroundReplySchema, await send(request));
  if (!reply.ok) throw new Error(reply.error);
}

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
    // The focus either moves back or not; the dashboard has nothing to show about it.
    void ask(send, returnToDashboardMessage()).catch(() => {});
  });
  return async (tabId) => {
    if (release) return;
    release = await tryHoldLock(CONTROL_LOCK);
    if (!release) throw new Error(CONTROLLED_ELSEWHERE);
    page.parent.postMessage(openPanelMessage(), parent);
    try {
      await ask(send, startSessionMessage(tabId));
    } catch (error) {
      // No session started, so this dashboard controls nothing; the error reaches the tab list.
      release();
      release = undefined;
      throw error;
    }
  };
}

function startFramed(root: HTMLElement, data: DashboardData, page: Window) {
  data.holdSitePorts?.();
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

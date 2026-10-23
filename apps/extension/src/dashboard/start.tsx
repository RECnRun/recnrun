import type { Snapshot } from "@recnrun/domain";
import { render } from "preact";
import { useState } from "preact/hooks";
import { disallowedAncestor } from "@/config/origins";
import { Dashboard } from "@/dashboard/Dashboard";
import type { TabSource } from "@/dashboard/open-tabs";
import { createFrameRouter, createHashRouter } from "@/dashboard/router";
import type { SessionActions, SessionSetup } from "@/dashboard/TabList";
import { openPanelMessage } from "@/messaging/frame-protocol";
import { floatSessionMessage, openSessionMessage } from "@/messaging/session-protocol";
import type { SessionRequest } from "@/messaging/session-protocol";
import { documentPip, requestPanelWindow, showSession } from "@/pip/document-pip";
import type { RecordingStore } from "@/views/recording";
import { Refusal } from "@/views/Refusal";

/** What the dashboard reads and does, injected so tests need no extension APIs. */
export interface DashboardData {
  loadSnapshot: () => Promise<Snapshot>;
  recordings: RecordingStore;
  /** The browser's tabs; without them the dashboard lists no tab to record. */
  tabs?: TabSource;
  /** Sends a session request to the background. */
  send: (request: SessionRequest) => void;
}

const SESSION_PATH = "/session.html";

/** A top-level dashboard opens the session's PiP window itself, then asks to record the tab. */
function topLevelActions(page: Window, send: (request: SessionRequest) => void): SessionActions {
  const pip = documentPip(page);
  const record = (tabId: number) => send(openSessionMessage(tabId));
  if (!pip) return { record };
  const float = async (tabId: number) => {
    // Nothing may await before this call, or Chrome refuses it for lack of user activation.
    const pipWindow = await requestPanelWindow(pip);
    showSession(pipWindow, new URL(SESSION_PATH, page.location.href).href, page.location.origin);
    send(floatSessionMessage(tabId));
  };
  return { record, float };
}

/** A frame cannot open a PiP window, so the site's content script opens it. */
function framedActions(page: Window, parent: string, send: (request: SessionRequest) => void) {
  const actions: SessionActions = {
    record: (tabId) => send(openSessionMessage(tabId)),
    float: async (tabId) => {
      page.parent.postMessage(openPanelMessage(), parent);
      send(floatSessionMessage(tabId));
    },
  };
  return actions;
}

function sessionSetup(data: DashboardData, actions: SessionActions): SessionSetup | undefined {
  if (!data.tabs) return undefined;
  return { tabs: data.tabs, store: data.recordings, actions };
}

function TopLevelDashboard({ data, page }: { data: DashboardData; page: Window }) {
  const [router] = useState(() => createHashRouter(page));
  const [session] = useState(() => sessionSetup(data, topLevelActions(page, data.send)));
  return <Dashboard loadSnapshot={data.loadSnapshot} router={router} session={session} />;
}

function startFramed(root: HTMLElement, data: DashboardData, page: Window) {
  const parent = page.location.ancestorOrigins[0] ?? "";
  const actions = framedActions(page, parent, data.send);
  render(
    <Dashboard
      loadSnapshot={data.loadSnapshot}
      router={createFrameRouter(parent, page)}
      session={sessionSetup(data, actions)}
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

import type { RequestResult } from "@recnrun/bridge";
import type { Browser } from "wxt/browser";
import type { Route, Routes, Sender } from "@/background/listener";
import { focusTab, startSession } from "@/background/session-requests";
import type { RecordingStore } from "@/ports/recording-store";

interface RouteDependencies {
  extensionVersion: string;
  store: RecordingStore;
  /** Focuses the first dashboard tab, or opens one, near the window it was asked from. */
  showDashboard: (from?: { windowId: number; incognito: boolean }) => Promise<void>;
}

const ANY: readonly Sender[] = ["contentScript", "ownPage"];
/** Session requests come from the dashboard tabs, never from the site's content script. */
const OWN_PAGE: readonly Sender[] = ["ownPage"];
/** Only the site asks for the dashboard; any script on it may, and it learns nothing back. */
const SITE: readonly Sender[] = ["contentScript"];

/**
 * The route table, one case per message type; the exhaustive switch makes a new type fail to
 * compile until it has a route. Bridge requests answer with the result their schema promises.
 */
export function createRoutes({
  extensionVersion,
  store,
  showDashboard,
}: RouteDependencies): Routes {
  const ping = async (): Promise<RequestResult<"ping">> => ({ extensionVersion });
  const openDashboard = async ({ tab }: Browser.runtime.MessageSender) => {
    await showDashboard(tab && { windowId: tab.windowId, incognito: tab.incognito });
    return {} satisfies RequestResult<"open-dashboard">;
  };
  return (message): Route => {
    switch (message.type) {
      case "ping":
        return { from: ANY, run: ping };
      case "open-dashboard":
        return { from: SITE, run: openDashboard };
      case "start-session":
        return { from: OWN_PAGE, run: () => startSession(message.tabId, store) };
      case "return-to-dashboard":
        // The sender's tab is the dashboard whose PiP window closed.
        return {
          from: OWN_PAGE,
          run: ({ tab }) => (tab?.id === undefined ? Promise.resolve() : focusTab(tab.id)),
        };
    }
  };
}

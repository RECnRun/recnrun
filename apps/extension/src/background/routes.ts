import type { RequestResult } from "@recnrun/bridge";
import type { Route, Routes, Sender } from "@/background/listener";
import { focusTab, startSession } from "@/background/session-requests";
import type { SessionStore } from "@/background/session-requests";

interface RouteDependencies {
  extensionVersion: string;
  store: SessionStore;
}

const ANY: readonly Sender[] = ["contentScript", "ownPage"];
/** Session requests come from the framed dashboard, never from the site's content script. */
const OWN_PAGE: readonly Sender[] = ["ownPage"];

/**
 * The route table, one case per message type; the exhaustive switch makes a new type fail to
 * compile until it has a route. Bridge requests answer with the result their schema promises.
 */
export function createRoutes({ extensionVersion, store }: RouteDependencies): Routes {
  const ping = async (): Promise<RequestResult<"ping">> => ({ extensionVersion });
  return (message): Route => {
    switch (message.type) {
      case "ping":
        return { from: ANY, run: ping };
      case "start-session":
        return { from: OWN_PAGE, run: () => startSession(message.tabId, store) };
      case "return-to-dashboard":
        // The dashboard is framed in a site tab, which is the tab it gets the focus back to.
        return {
          from: OWN_PAGE,
          run: ({ tab }) => (tab?.id === undefined ? Promise.resolve() : focusTab(tab.id)),
        };
    }
  };
}

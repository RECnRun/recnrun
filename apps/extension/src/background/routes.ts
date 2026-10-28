import type { RequestResult } from "@recnrun/bridge";
import type { Route, Routes, Sender } from "@/background/listener";
import { focusTab, startSession } from "@/background/session-requests";
import type { WorkspaceCommands } from "@/background/workspace/commands";
import type { RecordingStore } from "@/ports/recording-store";

interface RouteDependencies {
  extensionVersion: string;
  store: RecordingStore;
  workspace: WorkspaceCommands;
}

const ANY: readonly Sender[] = ["contentScript", "ownPage"];
/** Session and workspace requests come from the framed dashboard, never from the site's content script. */
const OWN_PAGE: readonly Sender[] = ["ownPage"];

/**
 * The route table, one case per message type; the exhaustive switch makes a new type fail to
 * compile until it has a route. Bridge requests answer with the result their schema promises.
 */
export function createRoutes({ extensionVersion, store, workspace }: RouteDependencies): Routes {
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
      case "workspace-status":
        return { from: OWN_PAGE, run: () => workspace.status() };
      case "workspace-start":
        return { from: OWN_PAGE, run: () => workspace.start(message.url) };
      case "workspace-close-and-start":
        return {
          from: OWN_PAGE,
          run: () => workspace.closeAndStart(message.url, message.windowIds),
        };
    }
  };
}

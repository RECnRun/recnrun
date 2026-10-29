import type { RequestResult } from "@recnrun/bridge";
import type { Route, Routes, Sender } from "@/background/listener";
import type { BackgroundMessage } from "@/messaging/background-messages";
import { focusTab, startSession } from "@/background/session-requests";
import type { WorkspaceCommands } from "@/background/workspace/commands";
import type { WorkspaceRequest } from "@/messaging/workspace-protocol";
import type { RecordingStore } from "@/ports/recording-store";

interface RouteDependencies {
  extensionVersion: string;
  store: RecordingStore;
  workspace: WorkspaceCommands;
}

const ANY: readonly Sender[] = ["contentScript", "ownPage"];
/** Session and workspace requests come from the framed dashboard, never from the site's content script. */
const OWN_PAGE: readonly Sender[] = ["ownPage"];

type StartRequest = Extract<
  WorkspaceRequest,
  {
    type:
      | "workspace-status"
      | "workspace-start"
      | "workspace-close-and-start"
      | "workspace-restart";
  }
>;
type LifecycleRequest = Exclude<WorkspaceRequest, StartRequest>;

const LIFECYCLE_TYPES: ReadonlySet<string> = new Set<LifecycleRequest["type"]>([
  "workspace-switch",
  "workspace-suspend",
  "workspace-resume",
  "workspace-new-identity",
  "workspace-close-windows",
  "workspace-delete-identity",
]);

const isLifecycleRequest = (message: WorkspaceRequest): message is LifecycleRequest =>
  LIFECYCLE_TYPES.has(message.type);

// Every workspace message type, and only those, carries the prefix (`workspace-protocol.ts`).
const isWorkspaceRequest = (message: BackgroundMessage): message is WorkspaceRequest =>
  message.type.startsWith("workspace-");

/** Switch to, Suspend, Resume, New identity, Close windows, and Delete. */
function lifecycleRoute(message: LifecycleRequest, workspace: WorkspaceCommands): Route {
  switch (message.type) {
    case "workspace-switch":
      return { from: OWN_PAGE, run: () => workspace.switchTo(message.identityId) };
    case "workspace-suspend":
      return { from: OWN_PAGE, run: () => workspace.suspend() };
    case "workspace-resume":
      return { from: OWN_PAGE, run: () => workspace.resume(message.identityId) };
    case "workspace-new-identity": {
      const { label, url } = message;
      const draft = { url, ...(label !== undefined && { label }) };
      return { from: OWN_PAGE, run: () => workspace.newIdentity(draft) };
    }
    case "workspace-close-windows":
      return { from: OWN_PAGE, run: () => workspace.closeWindows(message.windowIds) };
    case "workspace-delete-identity":
      return { from: OWN_PAGE, run: () => workspace.deleteIdentity(message.identityId) };
  }
}

function workspaceRoute(message: WorkspaceRequest, workspace: WorkspaceCommands): Route {
  if (isLifecycleRequest(message)) return lifecycleRoute(message, workspace);
  switch (message.type) {
    case "workspace-status":
      return { from: OWN_PAGE, run: () => workspace.status() };
    case "workspace-start":
      return { from: OWN_PAGE, run: () => workspace.start(message.url) };
    case "workspace-close-and-start":
      return { from: OWN_PAGE, run: () => workspace.closeAndStart(message.url, message.windowIds) };
    case "workspace-restart":
      return { from: OWN_PAGE, run: () => workspace.restart(message.url) };
  }
}

/**
 * The route table, one case per message type; the exhaustive switch makes a new type fail to
 * compile until it has a route. Bridge requests answer with the result their schema promises.
 */
export function createRoutes({ extensionVersion, store, workspace }: RouteDependencies): Routes {
  const ping = async (): Promise<RequestResult<"ping">> => ({ extensionVersion });
  return (message): Route => {
    if (isWorkspaceRequest(message)) return workspaceRoute(message, workspace);
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

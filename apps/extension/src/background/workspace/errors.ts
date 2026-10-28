import { errorMessage } from "@recnrun/domain";

/** Why a workspace operation stopped; the name tells cases apart, the message is for the user. */
type WorkspaceErrorName =
  | "AgentDisconnected"
  | "AgentNotConnected"
  | "BarrierCollision"
  | "BarrierNotInstalled"
  | "BarrierNotRemoved"
  | "CaptureFailed"
  | "CaptureIncomplete"
  | "CaptureMissing"
  | "CaptureTimedOut"
  | "CookieNotSet"
  | "CookieStoreNotFound"
  | "IncognitoNotAllowed"
  | "IncognitoNotGone"
  | "IncognitoWindowsOpen"
  | "InjectedFailure"
  | "NavigationFailed"
  | "NavigationTimedOut"
  | "NoManagedWindow"
  | "OffOriginNavigation"
  | "RecordingInProgress"
  | "RestoreFailed"
  | "RestoreTimedOut"
  | "TabClosed"
  | "TargetNotAllowed"
  | "WindowNotCreated"
  | "WindowsChanged"
  | "WindowsNotClosed"
  | "WorkspaceBusy"
  | "WorkspaceOpen";

export class WorkspaceError extends Error {
  constructor(name: WorkspaceErrorName, message: string) {
    super(message);
    this.name = name;
  }
}

/** Runs undo steps that must all be tried, collecting the messages of those that fail. */
export function collectFailures() {
  const failures: string[] = [];
  const attempt = async (undo: () => Promise<void>) => {
    try {
      await undo();
    } catch (error) {
      failures.push(errorMessage(error));
    }
  };
  return { failures, attempt };
}

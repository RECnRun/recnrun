/** Why a workspace operation stopped; the name tells cases apart, the message is for the user. */
type WorkspaceErrorName =
  | "AgentDisconnected"
  | "AgentNotConnected"
  | "BarrierCollision"
  | "BarrierNotInstalled"
  | "BarrierNotRemoved"
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

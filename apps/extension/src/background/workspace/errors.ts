/** Why a workspace operation stopped; the name tells cases apart, the message is for the user. */
type WorkspaceErrorName =
  | "IncognitoNotAllowed"
  | "IncognitoWindowsOpen"
  | "NoManagedWindow"
  | "RecordingInProgress"
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

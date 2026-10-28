/** Why a workspace operation stopped; the name tells cases apart, the message is for the user. */
type WorkspaceErrorName =
  | "IncognitoNotAllowed"
  | "IncognitoWindowsOpen"
  | "TargetNotAllowed"
  | "WindowNotCreated"
  | "WindowsChanged"
  | "WindowsNotClosed"
  | "WorkspaceBusy";

export class WorkspaceError extends Error {
  constructor(name: WorkspaceErrorName, message: string) {
    super(message);
    this.name = name;
  }
}

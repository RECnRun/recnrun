import type { WorkspaceRequest, WorkspaceStatus } from "@/messaging/workspace-protocol";

type PanelCommand =
  | "workspace-new-identity"
  | "workspace-switch"
  | "workspace-resume"
  | "workspace-suspend"
  | "workspace-delete-identity"
  | "workspace-close-windows";

/** The requests the workspace panel sends; the others are for tests and recovery. */
export type PanelRequest = Extract<WorkspaceRequest, { type: PanelCommand }>;

/** Each request by the button that sends it. */
const COMMAND_NAMES: Record<PanelCommand, string> = {
  "workspace-new-identity": "New identity",
  "workspace-switch": "Switch to",
  "workspace-resume": "Switch to",
  "workspace-suspend": "Close",
  "workspace-delete-identity": "Delete",
  "workspace-close-windows": "Close these windows",
};

const OPERATION_NAMES: Record<NonNullable<WorkspaceStatus["operation"]>["kind"], string> = {
  "start-with-identity": "Start with an identity",
  switch: "Switch to",
  suspend: "Close",
  resume: "Switch to",
  "new-identity": "New identity",
  "delete-identity": "Delete",
};

/** A command the background refused, by the request the panel sent. */
export interface CommandFailure {
  request: PanelRequest;
  error: string;
}

interface AlertSources {
  status: WorkspaceStatus | undefined;
  /** The operation that had already failed when the latest command started. */
  dismissed: string | undefined;
  failure: CommandFailure | undefined;
  readError: string | undefined;
}

/**
 * The panel's one alert: a journaled failure names its step, so it wins over the same command's
 * error; a failure from before the latest command no longer shows.
 */
export function panelAlert({ status, dismissed, failure, readError }: AlertSources) {
  const operation = status?.operation;
  if (operation?.status === "failed" && operation.id !== dismissed) {
    const name = OPERATION_NAMES[operation.kind];
    return `${name} failed at the ${operation.step} step. ${operation.error ?? ""}`.trimEnd();
  }
  if (failure) return `${COMMAND_NAMES[failure.request.type]} failed. ${failure.error}`;
  return readError;
}

/** What the user asks of the Incognito workspace and its saved identities. */
export type LifecycleCommand =
  | { kind: "switch"; identityId: string }
  | { kind: "resume"; identityId: string }
  | { kind: "new-identity"; identityId: string }
  | { kind: "delete-identity"; identityId: string }
  | { kind: "suspend" };

type StartCommand = Extract<LifecycleCommand, { kind: "switch" | "resume" | "new-identity" }>;

/** What a command is decided on; the coordinator reads it fresh under its lock. */
export interface LifecycleState {
  recording: boolean;
  /** Incognito windows open while no session is; while one is, every window is the session's. */
  foreignWindows: number;
  /** The open session, and the identity it holds when it holds one. */
  open: { identityId?: string } | undefined;
  identities: readonly { id: string; captured: boolean }[];
}

/**
 * The steps a command runs, in order: save the open identity (`capture` publishes, `persist`
 * records it on the identity) before `close`, then open the target restored or empty.
 */
export type LifecycleStep =
  | "capture"
  | "persist"
  | "close"
  | "start-from-capture"
  | "start-empty"
  | "remove";

/** Why the plan refuses a command; the coordinator raises it under the same name. */
export type LifecycleRefusalName =
  | "RecordingInProgress"
  | "IncognitoWindowsOpen"
  | "IdentityNotFound"
  | "IdentityOpen"
  | "NoManagedWindow"
  | "NoActiveIdentity"
  | "WorkspaceOpen"
  | "CaptureMissing";

export interface LifecycleRefusal {
  name: LifecycleRefusalName;
  message: string;
}

export type LifecyclePlan =
  | { ok: true; steps: LifecycleStep[] }
  | { ok: false; refusal: LifecycleRefusal };

const LEAVE: LifecycleStep[] = ["capture", "persist", "close"];

const refuse = (name: LifecycleRefusalName, message: string): LifecyclePlan => ({
  ok: false,
  refusal: { name, message },
});

const REFUSALS = {
  recording: refuse("RecordingInProgress", "Stop the recording first."),
  foreign: refuse("IncognitoWindowsOpen", "Close the other Incognito windows first."),
  unknown: refuse("IdentityNotFound", "RECnRun has no such identity."),
  open: refuse("IdentityOpen", "This identity is open; suspend it or switch to another first."),
  closed: refuse("NoManagedWindow", "No Incognito workspace is open; start one first."),
  anonymous: refuse(
    "NoActiveIdentity",
    "The open workspace belongs to no identity, so RECnRun cannot save it; close it first.",
  ),
  busyWindow: refuse("WorkspaceOpen", "Suspend the open identity or switch to this one."),
  missing: refuse("CaptureMissing", "RECnRun has no saved data for this identity."),
} satisfies Record<string, LifecyclePlan>;

const plan = (steps: LifecycleStep[]): LifecyclePlan => ({ ok: true, steps });

/** Saving the open identity first, if any; a window without one cannot be saved. */
function leaving(state: LifecycleState): LifecyclePlan {
  if (state.open === undefined) return plan([]);
  return state.open.identityId === undefined ? REFUSALS.anonymous : plan(LEAVE);
}

/**
 * Commands that open or close windows: refused while recording (OD-2), or beside Incognito windows
 * the user opened before any session, which hold no identity and would share the next one's profile.
 */
function windowGuard(state: LifecycleState): LifecyclePlan | undefined {
  if (state.recording) return REFUSALS.recording;
  if (state.foreignWindows > 0) return REFUSALS.foreign;
  return undefined;
}

function planStart(command: StartCommand, state: LifecycleState): LifecyclePlan {
  const target = state.identities.find(({ id }) => id === command.identityId);
  if (target === undefined) return REFUSALS.unknown;
  if (state.open?.identityId === target.id) return REFUSALS.open;
  if (command.kind === "resume") {
    if (state.open !== undefined) return REFUSALS.busyWindow;
    if (!target.captured) return REFUSALS.missing;
  }
  const before = leaving(state);
  if (!before.ok) return before;
  const start: LifecycleStep =
    target.captured && command.kind !== "new-identity" ? "start-from-capture" : "start-empty";
  return plan([...before.steps, start]);
}

/** Decides what `command` does in `state`: its steps, or why it is refused. Pure. */
export function planLifecycle(command: LifecycleCommand, state: LifecycleState): LifecyclePlan {
  if (command.kind === "delete-identity") {
    if (!state.identities.some(({ id }) => id === command.identityId)) return REFUSALS.unknown;
    return state.open?.identityId === command.identityId ? REFUSALS.open : plan(["remove"]);
  }
  const guard = windowGuard(state);
  if (guard) return guard;
  if (command.kind !== "suspend") return planStart(command, state);
  return state.open === undefined ? REFUSALS.closed : leaving(state);
}

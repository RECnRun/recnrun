import * as v from "valibot";

/** Recording session states (source plan §6). */
export const SESSION_STATES = [
  "idle",
  "recording",
  "paused",
  "finalizing",
  "completed",
  "interrupted",
] as const;

/** Who drives a target; separate from the session state, so an agent can leave mid-session. */
export const CONTROL_STATES = ["manual", "agent", "replay", "unassigned"] as const;

export const STEP_STATES = [
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "indeterminate",
] as const;

export const SessionStateSchema = v.picklist(SESSION_STATES);
export const ControlStateSchema = v.picklist(CONTROL_STATES);
export const StepStateSchema = v.picklist(STEP_STATES);

export type SessionState = v.InferOutput<typeof SessionStateSchema>;
export type ControlState = v.InferOutput<typeof ControlStateSchema>;
export type StepState = v.InferOutput<typeof StepStateSchema>;

type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

/** Completed and interrupted sessions are final: an interrupted run is inspected, never resumed. */
export const SESSION_TRANSITIONS: Transitions<SessionState> = {
  idle: ["recording"],
  recording: ["paused", "finalizing", "interrupted"],
  paused: ["recording", "finalizing", "interrupted"],
  finalizing: ["completed", "interrupted"],
  completed: [],
  interrupted: [],
};

/** Control is released before another client takes it; only a person may take it over directly. */
export const CONTROL_TRANSITIONS: Transitions<ControlState> = {
  unassigned: ["manual", "agent", "replay"],
  manual: ["unassigned"],
  agent: ["unassigned", "manual"],
  replay: ["unassigned", "manual"],
};

/** Final step states lead nowhere: a write whose outcome is unknown stays `indeterminate`. */
export const STEP_TRANSITIONS: Transitions<StepState> = {
  pending: ["running", "blocked", "cancelled"],
  running: ["passed", "failed", "cancelled", "indeterminate"],
  passed: [],
  failed: [],
  blocked: [],
  cancelled: [],
  indeterminate: [],
};

/** True when `transitions` lets a machine move from `from` to `to`. */
export function isLegalTransition<S extends string>(
  transitions: Transitions<S>,
  from: S,
  to: S,
): boolean {
  return transitions[from].includes(to);
}

/**
 * The three distinct pauses of source plan §6: `pauseStepCreation` keeps capturing but suggests no
 * steps, `pauseReplay` stops the executor before its next step, and `suspendCapture` stops the
 * observers, which opens a coverage gap.
 */
export const PAUSE_MODES = ["pauseStepCreation", "pauseReplay", "suspendCapture"] as const;

/** Each pause is its own two-state machine, so pausing one never touches the others. */
export const PAUSE_STATES = ["active", "paused"] as const;

export const PauseModeSchema = v.picklist(PAUSE_MODES);
export const PauseStateSchema = v.picklist(PAUSE_STATES);

export type PauseMode = v.InferOutput<typeof PauseModeSchema>;
export type PauseState = v.InferOutput<typeof PauseStateSchema>;

export const PAUSE_TRANSITIONS: Transitions<PauseState> = {
  active: ["paused"],
  paused: ["active"],
};

/** The state of each pause of a session. */
export const SessionPausesSchema = v.strictObject({
  pauseStepCreation: PauseStateSchema,
  pauseReplay: PauseStateSchema,
  suspendCapture: PauseStateSchema,
});

export type SessionPauses = v.InferOutput<typeof SessionPausesSchema>;

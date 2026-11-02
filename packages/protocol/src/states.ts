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

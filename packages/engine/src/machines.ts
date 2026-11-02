import type { ControlState, PauseState, SessionState, StepState } from "@recnrun/protocol";
import { defineMachine, type TransitionTable } from "./machine.ts";

// The tables below reach exactly the targets `*_TRANSITIONS` of the protocol lists (session.test.ts).

export const SESSION_EVENTS = [
  "start",
  "pause",
  "resume",
  "stop",
  "complete",
  "interrupt",
] as const;
export type SessionEvent = (typeof SESSION_EVENTS)[number];

/** Completed and interrupted sessions are final; `pause`/`resume` follow the three pauses. */
export const SESSION_TABLE: TransitionTable<SessionState, SessionEvent> = {
  idle: { start: "recording" },
  recording: { pause: "paused", stop: "finalizing", interrupt: "interrupted" },
  paused: { resume: "recording", stop: "finalizing", interrupt: "interrupted" },
  finalizing: { complete: "completed", interrupt: "interrupted" },
  completed: {},
  interrupted: {},
};

export const CONTROL_EVENTS = [
  "acquireManual",
  "acquireAgent",
  "acquireReplay",
  "release",
  "expire",
  "takeControl",
] as const;
export type ControlEvent = (typeof CONTROL_EVENTS)[number];

/** A holder acquires only a free target; only a person takes control over directly. */
export const CONTROL_TABLE: TransitionTable<ControlState, ControlEvent> = {
  unassigned: { acquireManual: "manual", acquireAgent: "agent", acquireReplay: "replay" },
  manual: { release: "unassigned", expire: "unassigned" },
  agent: { release: "unassigned", expire: "unassigned", takeControl: "manual" },
  replay: { release: "unassigned", expire: "unassigned", takeControl: "manual" },
};

export const STEP_EVENTS = ["start", "block", "cancel", "pass", "fail", "outcomeUnknown"] as const;
export type StepEvent = (typeof STEP_EVENTS)[number];

/** A dispatched write whose outcome is unknown becomes `indeterminate` and is never retried. */
export const STEP_TABLE: TransitionTable<StepState, StepEvent> = {
  pending: { start: "running", block: "blocked", cancel: "cancelled" },
  running: { pass: "passed", fail: "failed", cancel: "cancelled", outcomeUnknown: "indeterminate" },
  passed: {},
  failed: {},
  blocked: {},
  cancelled: {},
  indeterminate: {},
};

export const PAUSE_EVENTS = ["pause", "resume"] as const;
export type PauseEvent = (typeof PAUSE_EVENTS)[number];

export const PAUSE_TABLE: TransitionTable<PauseState, PauseEvent> = {
  active: { pause: "paused" },
  paused: { resume: "active" },
};

export const sessionTransition = defineMachine("session", SESSION_TABLE);
export const controlTransition = defineMachine("control", CONTROL_TABLE);
export const stepTransition = defineMachine("step", STEP_TABLE);
export const pauseTransition = defineMachine("pause", PAUSE_TABLE);

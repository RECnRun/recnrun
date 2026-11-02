import type { PauseMode, SessionPauses, SessionState } from "@recnrun/protocol";
import type { IllegalTransition } from "./machine.ts";
import { pauseTransition, sessionTransition, type SessionEvent } from "./machines.ts";

/** A session's lifecycle state, its three independent pauses, and when capture was suspended. */
export interface Session {
  state: SessionState;
  pauses: SessionPauses;
  captureSuspendedAt: number | null;
}

/** The span during which capture was suspended; the journal records it as a gap. */
export interface CaptureGap {
  reason: "capture-suspended";
  startedAt: number;
  endedAt: number;
}

export type SessionResult =
  | { ok: true; session: Session; gap?: CaptureGap }
  | { ok: false; error: IllegalTransition };

/** Session events other than `pause` and `resume`, which only the three pauses drive. */
export type LifecycleEvent = Exclude<SessionEvent, "pause" | "resume">;

export function createSession(): Session {
  return {
    state: "idle",
    pauses: { pauseStepCreation: "active", pauseReplay: "active", suspendCapture: "active" },
    captureSuspendedAt: null,
  };
}

export function applySessionEvent(session: Session, event: LifecycleEvent): SessionResult {
  const next = sessionTransition(session.state, event);
  return next.ok ? { ok: true, session: { ...session, state: next.state } } : next;
}

function isLive(session: Session): boolean {
  return session.state === "recording" || session.state === "paused";
}

function notLive(session: Session, mode: PauseMode): SessionResult {
  const error: IllegalTransition = {
    code: "illegal-transition",
    machine: "session",
    from: session.state,
    event: mode,
  };
  return { ok: false, error };
}

// Matches the session table: `pause` while any pause holds, `resume` when the last one ends.
function settle(pauses: SessionPauses): SessionState {
  return Object.values(pauses).includes("paused") ? "paused" : "recording";
}

/** Pauses one of the three; the other two keep their state. */
export function pauseSession(session: Session, mode: PauseMode, now: number): SessionResult {
  if (!isLive(session)) return notLive(session, mode);
  const next = pauseTransition(session.pauses[mode], "pause");
  if (!next.ok) return next;
  const pauses = { ...session.pauses, [mode]: next.state };
  const captureSuspendedAt = mode === "suspendCapture" ? now : session.captureSuspendedAt;
  return { ok: true, session: { state: settle(pauses), pauses, captureSuspendedAt } };
}

/** Resumes one of the three; resuming capture closes the gap its suspension opened. */
export function resumeSession(session: Session, mode: PauseMode, now: number): SessionResult {
  if (!isLive(session)) return notLive(session, mode);
  const next = pauseTransition(session.pauses[mode], "resume");
  if (!next.ok) return next;
  const pauses = { ...session.pauses, [mode]: next.state };
  const startedAt = session.captureSuspendedAt;
  if (mode !== "suspendCapture" || startedAt === null) {
    return { ok: true, session: { ...session, state: settle(pauses), pauses } };
  }
  const resumed = { state: settle(pauses), pauses, captureSuspendedAt: null };
  return {
    ok: true,
    session: resumed,
    gap: { reason: "capture-suspended", startedAt, endedAt: now },
  };
}

/** Raw events become suggested steps unless step creation is paused. */
export function createsSuggestedSteps(session: Session): boolean {
  return isLive(session) && session.pauses.pauseStepCreation === "active";
}

/** The replay executor checks this before each step, never in the middle of one. */
export function mayStartNextStep(session: Session): boolean {
  return isLive(session) && session.pauses.pauseReplay === "active";
}

/** Observers buffer events unless capture is suspended. */
export function isCapturing(session: Session): boolean {
  return isLive(session) && session.pauses.suspendCapture === "active";
}

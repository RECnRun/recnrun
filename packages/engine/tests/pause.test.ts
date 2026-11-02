import { describe, expect, test } from "vite-plus/test";
import { PAUSE_MODES, type PauseMode } from "@recnrun/protocol";
import {
  applySessionEvent,
  createSession,
  createsSuggestedSteps,
  isCapturing,
  mayStartNextStep,
  pauseSession,
  resumeSession,
  type Session,
  type SessionResult,
} from "../src/index.ts";

function ok(result: SessionResult): Session {
  if (!result.ok) throw new Error(`expected a session, got ${result.error.code}`);
  return result.session;
}

const recording = ok(applySessionEvent(createSession(), "start"));

function effects(session: Session) {
  return {
    steps: createsSuggestedSteps(session),
    replay: mayStartNextStep(session),
    capture: isCapturing(session),
  };
}

// What each pause turns off; the other two effects stay on.
const turnsOff: Record<PauseMode, keyof ReturnType<typeof effects>> = {
  pauseStepCreation: "steps",
  pauseReplay: "replay",
  suspendCapture: "capture",
};

describe.each(PAUSE_MODES)("%s", (mode) => {
  test("leaves the other two pauses untouched", () => {
    const paused = ok(pauseSession(recording, mode, 100));
    for (const other of PAUSE_MODES) {
      expect(paused.pauses[other], other).toBe(other === mode ? "paused" : "active");
    }
    expect(paused.state).toBe("paused");
    expect(effects(paused)).toEqual({ ...effects(recording), [turnsOff[mode]]: false });
  });

  test("resumes on its own while the other two stay paused", () => {
    let session = recording;
    for (const each of PAUSE_MODES) session = ok(pauseSession(session, each, 100));
    session = ok(resumeSession(session, mode, 200));
    for (const other of PAUSE_MODES) {
      expect(session.pauses[other], other).toBe(other === mode ? "active" : "paused");
    }
    expect(session.state, "another pause is still in effect").toBe("paused");
    const off = { steps: false, replay: false, capture: false };
    expect(effects(session)).toEqual({ ...off, [turnsOff[mode]]: true });
  });

  test("cannot pause twice or resume while active", () => {
    const paused = ok(pauseSession(recording, mode, 100));
    expect(pauseSession(paused, mode, 101)).toEqual({
      ok: false,
      error: { code: "illegal-transition", machine: "pause", from: "paused", event: "pause" },
    });
    expect(resumeSession(recording, mode, 101)).toEqual({
      ok: false,
      error: { code: "illegal-transition", machine: "pause", from: "active", event: "resume" },
    });
  });

  test("needs a live session", () => {
    expect(pauseSession(createSession(), mode, 100)).toEqual({
      ok: false,
      error: { code: "illegal-transition", machine: "session", from: "idle", event: mode },
    });
    const finalizing = ok(applySessionEvent(recording, "stop"));
    expect(pauseSession(finalizing, mode, 100).ok).toBe(false);
  });
});

test("resuming the last pause returns the session to recording", () => {
  const paused = ok(pauseSession(recording, "pauseReplay", 100));
  const resumed = ok(resumeSession(paused, "pauseReplay", 200));
  expect(resumed).toEqual(recording);
  expect(effects(resumed)).toEqual({ steps: true, replay: true, capture: true });
});

test("pausing step creation keeps capture on but suggests no steps", () => {
  const paused = ok(pauseSession(recording, "pauseStepCreation", 100));
  expect(effects(paused)).toEqual({ steps: false, replay: true, capture: true });
});

test("suspending capture opens a coverage gap that its resume closes", () => {
  const suspended = pauseSession(recording, "suspendCapture", 100);
  expect(suspended.ok && suspended.gap).toBeUndefined();
  const resumed = resumeSession(ok(suspended), "suspendCapture", 250);
  expect(resumed).toEqual({
    ok: true,
    session: recording,
    gap: { reason: "capture-suspended", startedAt: 100, endedAt: 250 },
  });
});

test("only the capture resume reports a gap", () => {
  for (const mode of ["pauseStepCreation", "pauseReplay"] as const) {
    const resumed = resumeSession(ok(pauseSession(recording, mode, 100)), mode, 200);
    expect(resumed).toEqual({ ok: true, session: recording });
  }
});

test("a stopped or idle session captures nothing and runs no step", () => {
  expect(effects(createSession())).toEqual({ steps: false, replay: false, capture: false });
  const finalizing = ok(applySessionEvent(recording, "stop"));
  expect(effects(finalizing)).toEqual({ steps: false, replay: false, capture: false });
});

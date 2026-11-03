import { describe, expect, test } from "vite-plus/test";
import {
  CONTROL_STATES,
  CONTROL_TRANSITIONS,
  PAUSE_STATES,
  PAUSE_TRANSITIONS,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  STEP_STATES,
  STEP_TRANSITIONS,
} from "@recnrun/protocol";
import {
  CONTROL_EVENTS,
  PAUSE_EVENTS,
  SESSION_EVENTS,
  STEP_EVENTS,
  applySessionEvent,
  controlTransition,
  createSession,
  pauseTransition,
  sessionTransition,
  stepTransition,
  type Transition,
} from "../src/index.ts";

type Expected = Record<string, Record<string, string>>;

interface Machine {
  name: string;
  states: readonly string[];
  events: readonly string[];
  targets: Readonly<Record<string, readonly string[]>>;
  // Written by hand from source plan §6; every pair it omits must be illegal.
  expected: Expected;
  run(from: string, event: string): Transition<string>;
}

const machines: Machine[] = [
  {
    name: "session",
    states: SESSION_STATES,
    events: SESSION_EVENTS,
    targets: SESSION_TRANSITIONS,
    expected: {
      idle: { start: "recording" },
      recording: { pause: "paused", stop: "finalizing", interrupt: "interrupted" },
      paused: { resume: "recording", stop: "finalizing", interrupt: "interrupted" },
      finalizing: { complete: "completed", interrupt: "interrupted" },
    },
    run: sessionTransition,
  },
  {
    name: "control",
    states: CONTROL_STATES,
    events: CONTROL_EVENTS,
    targets: CONTROL_TRANSITIONS,
    expected: {
      unassigned: { acquireManual: "manual", acquireAgent: "agent", acquireReplay: "replay" },
      manual: { release: "unassigned", expire: "unassigned" },
      agent: { release: "unassigned", expire: "unassigned", takeControl: "manual" },
      replay: { release: "unassigned", expire: "unassigned", takeControl: "manual" },
    },
    run: controlTransition,
  },
  {
    name: "step",
    states: STEP_STATES,
    events: STEP_EVENTS,
    targets: STEP_TRANSITIONS,
    expected: {
      pending: { start: "running", block: "blocked", cancel: "cancelled" },
      running: {
        pass: "passed",
        fail: "failed",
        cancel: "cancelled",
        outcomeUnknown: "indeterminate",
      },
    },
    run: stepTransition,
  },
  {
    name: "pause",
    states: PAUSE_STATES,
    events: PAUSE_EVENTS,
    targets: PAUSE_TRANSITIONS,
    expected: { active: { pause: "paused" }, paused: { resume: "active" } },
    run: pauseTransition,
  },
];

describe.each(machines)("the $name machine", (machine) => {
  const matrix = machine.states.flatMap((from) =>
    machine.events.map((event) => [from, event, machine.expected[from]?.[event] ?? null] as const),
  );

  test.each(matrix)("%s on %s goes to %s", (from, event, next) => {
    const result = machine.run(from, event);
    if (next === null) {
      const error = { code: "illegal-transition", machine: machine.name, from, event };
      expect(result).toEqual({ ok: false, error });
    } else {
      expect(result).toEqual({ ok: true, state: next });
    }
  });

  test("reaches exactly the targets the protocol lists for each state", () => {
    for (const from of machine.states) {
      const reached = machine.events.flatMap((event) => {
        const result = machine.run(from, event);
        return result.ok ? [result.state] : [];
      });
      expect([...new Set(reached)].toSorted(), from).toEqual(
        [...(machine.targets[from] ?? [])].toSorted(),
      );
    }
  });
});

describe("a session's lifecycle", () => {
  test("starts, stops, and completes through the session machine", () => {
    let session = createSession();
    for (const event of ["start", "stop", "complete"] as const) {
      const result = applySessionEvent(session, event);
      if (!result.ok) throw new Error(result.error.code);
      session = result.session;
    }
    expect(session.state).toBe("completed");
  });

  test("rejects an event the current state does not accept and keeps nothing", () => {
    const result = applySessionEvent(createSession(), "complete");
    expect(result).toEqual({
      ok: false,
      error: { code: "illegal-transition", machine: "session", from: "idle", event: "complete" },
    });
  });
});

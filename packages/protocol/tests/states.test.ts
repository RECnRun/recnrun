import { describe, expect, test } from "vite-plus/test";
import {
  CONTROL_STATES,
  CONTROL_TRANSITIONS,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  STEP_STATES,
  STEP_TRANSITIONS,
  isLegalTransition,
} from "../src/index.ts";

const machines = [
  {
    name: "session",
    states: SESSION_STATES,
    transitions: SESSION_TRANSITIONS as Readonly<Record<string, readonly string[]>>,
    illegal: {
      idle: "completed",
      recording: "idle",
      paused: "completed",
      finalizing: "recording",
      completed: "recording",
      interrupted: "recording",
    } as Record<string, string>,
  },
  {
    name: "control",
    states: CONTROL_STATES,
    transitions: CONTROL_TRANSITIONS as Readonly<Record<string, readonly string[]>>,
    illegal: {
      manual: "agent",
      agent: "replay",
      replay: "agent",
      unassigned: "unassigned",
    } as Record<string, string>,
  },
  {
    name: "step",
    states: STEP_STATES,
    transitions: STEP_TRANSITIONS as Readonly<Record<string, readonly string[]>>,
    illegal: {
      pending: "passed",
      running: "pending",
      passed: "running",
      failed: "running",
      blocked: "running",
      cancelled: "running",
      indeterminate: "running",
    } as Record<string, string>,
  },
];

describe.each(machines)("the $name machine", ({ states, transitions, illegal }) => {
  test("lists transitions for exactly its states", () => {
    expect(Object.keys(transitions).toSorted()).toEqual([...states].toSorted());
    expect(Object.keys(illegal).toSorted()).toEqual([...states].toSorted());
  });

  test("accepts every legal transition", () => {
    const pairs = Object.entries(transitions).flatMap(([from, tos]) =>
      tos.map((to) => [from, to] as const),
    );
    expect(pairs.length).toBeGreaterThan(0);
    for (const [from, to] of pairs) {
      expect(isLegalTransition(transitions, from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  test.each(states)("rejects one illegal transition from %s", (from) => {
    const to = illegal[from] ?? "";
    expect(transitions[from]).not.toContain(to);
    expect(isLegalTransition(transitions, from, to)).toBe(false);
  });
});

test("terminal step states lead nowhere, so a write action is never retried blindly", () => {
  for (const state of ["passed", "failed", "blocked", "cancelled", "indeterminate"] as const) {
    expect(STEP_TRANSITIONS[state]).toEqual([]);
  }
});

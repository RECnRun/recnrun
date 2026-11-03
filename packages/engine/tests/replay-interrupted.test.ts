import type { AdapterEvent, Event, Step } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import {
  applySessionEvent,
  createSession,
  pauseSession,
  replayFlow,
  resumeSession,
  type ReplayDriver,
  type Session,
  type SessionResult,
} from "../src/index.ts";
import { actsOf, fakeClock, fakeDriver, flowOf, type FakePage } from "./replay-fakes.ts";

const LOST: AdapterEvent = {
  type: "connection.lost",
  seq: 7,
  at: "2026-11-03T10:00:00.050Z",
  endpoint: "ws://127.0.0.1:9222/devtools/browser/x",
  gap: { reason: "connection-lost", startedAt: "2026-11-03T10:00:00.050Z", lastSeq: 6 },
};

/** A driver that drops its connection once `when` says so, as Chrome killed mid-step would. */
function droppingDriver(page: FakePage, when: (calls: readonly string[]) => boolean) {
  const listeners = new Set<(event: AdapterEvent) => void>();
  const fake = fakeDriver(page);
  let dropped = false;
  const lose = () => {
    if (dropped) return;
    dropped = true;
    for (const listener of listeners) listener(LOST);
  };
  const drop = () => {
    if (when(fake.calls)) lose();
  };
  const driver: ReplayDriver = {
    ...fake.driver,
    inspect: async (target, options) => {
      const state = await fake.driver.inspect(target, options);
      drop();
      return state;
    },
    act: (command, options) => {
      const result = fake.driver.act(command, options);
      drop();
      return result;
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { driver, calls: fake.calls, lose };
}

function ok(result: SessionResult): Session {
  if (!result.ok) throw new Error(`expected a session, got ${result.error.code}`);
  return result.session;
}

/** A driver whose first click pauses the replay, so the run then waits on `control.changed()`. */
function pausingReplay(changed: (lose: () => void, resume: () => void) => Promise<void>) {
  let session = ok(applySessionEvent(createSession(), "start"));
  const { driver, calls, lose } = droppingDriver({ elements: { go: {} } }, () => false);
  const resume = () => void (session = ok(resumeSession(session, "pauseReplay", 2)));
  const act = driver.act.bind(driver);
  driver.act = async (command, options) => {
    const result = await act(command, options);
    if (actsOf(calls).length === 1) session = ok(pauseSession(session, "pauseReplay", 1));
    return result;
  };
  const control = { session: () => session, changed: () => changed(lose, resume) };
  const steps: Step[] = [NEXT, { ...NEXT, id: "after" }, { ...NEXT, id: "last" }];
  return { running: replayFlow(driver, flowOf(steps), { clock: fakeClock(), control }), calls };
}

const PAUSED_THEN_LOST = {
  status: "interrupted",
  exitCode: 2,
  steps: [expect.objectContaining({ stepId: "next", status: "passed" })],
  summary: expect.objectContaining({
    counts: expect.objectContaining({ passed: 1, cancelled: 2 }),
  }),
};

test("a lost connection ends a replay that pauseReplay holds", { timeout: 2000 }, async () => {
  let waiting: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (waiting = resolve));
  let lose: () => void = () => undefined;
  const { running, calls } = pausingReplay((loseConnection) => {
    lose = loseConnection;
    waiting();
    return new Promise<never>(() => {});
  });
  await held;
  lose();
  expect(await running).toMatchObject(PAUSED_THEN_LOST);
  expect(actsOf(calls), "no write after the loss").toEqual(["act click"]);
});

test("a loss that arrives with the resume cancels the remaining steps undispatched", async () => {
  const { running, calls } = pausingReplay(async (lose, resume) => {
    lose();
    resume();
  });
  expect(await running).toMatchObject(PAUSED_THEN_LOST);
  expect(actsOf(calls), "no write after the loss").toEqual(["act click"]);
});

const READS = (calls: readonly string[]) => calls.filter((call) => call.startsWith("inspect "));

const NEXT: Step = { id: "next", action: "click", target: { testId: "go" } };

test("a lost connection cuts a retrying assertion short: cancelled, and the run interrupted", async () => {
  const { driver, calls } = droppingDriver({}, (seen) => READS(seen).length === 3);
  const steps: Step[] = [
    { id: "seen", assertion: "visible", target: { testId: "box" }, timeoutMs: 10_000 },
    NEXT,
  ];
  const result = await replayFlow(driver, flowOf(steps), { clock: fakeClock() });
  expect(READS(calls), "no read after the loss").toHaveLength(3);
  expect(result.status).toBe("interrupted");
  expect(result.exitCode).toBe(2);
  expect(result.steps.map(({ stepId, status, error }) => [stepId, status, error?.code])).toEqual([
    ["seen", "cancelled", "connection-lost"],
  ]);
  expect(result.summary.counts).toMatchObject({ cancelled: 2, failed: 0, blocked: 0 });
  expect(result.summary.failures).toEqual([
    { stepId: "seen", message: expect.stringContaining("connection-lost") },
  ]);
});

test("a write the loss interrupts is indeterminate at once, though its answer never comes", async () => {
  const never = new Promise<never>(() => {});
  const page: FakePage = { elements: { go: {} }, act: () => never };
  const { driver } = droppingDriver(page, (seen) => seen.includes("act click"));
  const steps: Step[] = [
    { ...NEXT, timeoutMs: 1_000 },
    { ...NEXT, id: "after" },
  ];
  const result = await replayFlow(driver, flowOf(steps), { clock: fakeClock() });
  expect(result.status).toBe("interrupted");
  expect(result.exitCode).toBe(2);
  expect(result.steps.map(({ stepId, status, error }) => [stepId, status, error?.code])).toEqual([
    ["next", "indeterminate", "connection-lost"],
  ]);
  expect(result.summary.counts).toMatchObject({ indeterminate: 1, cancelled: 1 });
  expect(result.summary.failures).toEqual([
    { stepId: "next", message: expect.stringContaining("connection-lost") },
  ]);
});

test("a loss after the last step interrupts the run while every step keeps its pass", async () => {
  const { driver, lose } = droppingDriver({ elements: { go: {} } }, () => false);
  // Chrome goes away while the capture drains, after the last step passed.
  const capturing: ReplayDriver = {
    ...driver,
    onCapture: async () => ({ drain: async () => lose() }),
  };
  const events: Event[] = [];
  const result = await replayFlow(capturing, flowOf([NEXT, { ...NEXT, id: "after" }]), {
    clock: fakeClock(),
    observe: (event) => void events.push(event),
  });
  expect(events.filter(({ category }) => category === "gap").map(({ type }) => type)).toEqual([
    "connection-lost",
  ]);
  expect(result.steps.map(({ stepId, status }) => [stepId, status])).toEqual([
    ["next", "passed"],
    ["after", "passed"],
  ]);
  expect(result.summary.counts).toMatchObject({ passed: 2, cancelled: 0 });
  expect(result).toMatchObject({ status: "interrupted", exitCode: 2 });
});

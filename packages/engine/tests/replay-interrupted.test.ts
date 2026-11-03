import type { AdapterEvent, Step } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { replayFlow, type ReplayDriver } from "../src/index.ts";
import { fakeClock, fakeDriver, flowOf, type FakePage } from "./replay-fakes.ts";

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
  const drop = () => {
    if (dropped || !when(fake.calls)) return;
    dropped = true;
    for (const listener of listeners) listener(LOST);
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
  return { driver, calls: fake.calls };
}

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

import type { Step } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { replayFlow, systemClock, type ReplayDriver } from "../src/index.ts";
import { actsOf, fakeClock, fakeDriver, flowOf } from "./replay-fakes.ts";

const HERE = "http://127.0.0.1:4600/";
const AT_URL: Step = { id: "at", assertion: "url", expected: HERE, timeoutMs: 10 };
const never = <T>() => new Promise<T>(() => undefined);

test("a read that answers after the deadline never passes the step", async () => {
  const clock = fakeClock();
  const { driver } = fakeDriver({ tabs: { tabs: [{ url: HERE, title: "" }], current: 0 } });
  const slow: ReplayDriver = {
    ...driver,
    tabs: async (options) => {
      await clock.sleep(150);
      return driver.tabs(options);
    },
  };
  const outcome = await replayFlow(slow, flowOf([AT_URL]), { clock });
  expect(outcome.steps[0]).toMatchObject({ status: "failed", error: { code: "timeout" } });
});

test("a read that never answers fails the step at its deadline", async () => {
  const { driver } = fakeDriver();
  const stalled: ReplayDriver = { ...driver, tabs: never };
  const started = Date.now();
  const outcome = await replayFlow(stalled, flowOf([AT_URL]), { clock: systemClock });
  expect(outcome.steps[0]).toMatchObject({ status: "failed", error: { code: "timeout" } });
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a write that never answers is indeterminate at its deadline and dispatched once", async () => {
  const { driver, calls } = fakeDriver({ act: never });
  const step: Step = { id: "open", action: "openTab", timeoutMs: 20 };
  const started = Date.now();
  const outcome = await replayFlow(driver, flowOf([step]), { clock: systemClock });
  expect(outcome.steps[0]).toMatchObject({ status: "indeterminate", error: { code: "timeout" } });
  expect(actsOf(calls)).toEqual(["act openTab"]);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a write that answers after the deadline is indeterminate", async () => {
  const clock = fakeClock();
  const { driver, calls } = fakeDriver({
    act: async () => {
      await clock.sleep(150);
      return { status: "done" };
    },
  });
  const step: Step = { id: "go", action: "navigate", url: HERE, timeoutMs: 10 };
  const outcome = await replayFlow(driver, flowOf([step]), { clock });
  expect(outcome.steps[0]).toMatchObject({ status: "indeterminate", error: { code: "timeout" } });
  expect(actsOf(calls)).toEqual(["act navigate"]);
});

import { isStepResult, type Step } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { replayFlow, type DriverCommand } from "../src/index.ts";
import { actsOf, clone, fakeClock, fakeDriver, flowOf } from "./replay-fakes.ts";

const OPTIONS = { env: { base: "http://127.0.0.1:4600" }, inputs: { query: "pears" } };

const BOX = { testId: "box" };

describe("write actions", () => {
  test.each<[string, Step, DriverCommand]>([
    [
      "navigate",
      { id: "s", action: "navigate", url: "${env.base}/routes/replay" },
      { kind: "navigate", url: "http://127.0.0.1:4600/routes/replay" },
    ],
    ["reload", { id: "s", action: "reload" }, { kind: "reload" }],
    ["click", { id: "s", action: "click", target: BOX }, { kind: "click", target: BOX }],
    ["check", { id: "s", action: "check", target: BOX }, { kind: "check", target: BOX }],
    ["uncheck", { id: "s", action: "uncheck", target: BOX }, { kind: "uncheck", target: BOX }],
    [
      "fill",
      { id: "s", action: "fill", target: BOX, value: "${inputs.query}" },
      { kind: "fill", target: BOX, value: "pears" },
    ],
    [
      "type",
      { id: "s", action: "type", target: BOX, value: "a ${inputs.query}" },
      { kind: "type", target: BOX, value: "a pears" },
    ],
    [
      "select",
      { id: "s", action: "select", target: BOX, value: "Green" },
      { kind: "select", target: BOX, value: "Green" },
    ],
    [
      "keyPress on a target",
      { id: "s", action: "keyPress", key: "Enter", target: BOX },
      { kind: "keyPress", key: "Enter", target: BOX },
    ],
    [
      "keyPress on the page",
      { id: "s", action: "keyPress", key: "Escape" },
      { kind: "keyPress", key: "Escape", target: undefined },
    ],
    [
      "scroll the page",
      { id: "s", action: "scroll", deltaY: 600 },
      { kind: "scroll", target: undefined, deltaX: 0, deltaY: 600 },
    ],
    [
      "scroll a target",
      { id: "s", action: "scroll", target: BOX, deltaX: 5 },
      { kind: "scroll", target: BOX, deltaX: 5, deltaY: 0 },
    ],
    [
      "openTab",
      { id: "s", action: "openTab", url: "${env.base}/a" },
      { kind: "openTab", url: "http://127.0.0.1:4600/a" },
    ],
    ["openTab blank", { id: "s", action: "openTab" }, { kind: "openTab", url: undefined }],
    ["closeTab", { id: "s", action: "closeTab" }, { kind: "closeTab" }],
  ])("%s dispatches its command exactly once", async (_name, step, command) => {
    const { driver, commands } = fakeDriver({ elements: { box: {} } });
    const result = await replayFlow(driver, flowOf([step]), { ...OPTIONS, clock: fakeClock() });
    expect(result.status).toBe("passed");
    expect(commands).toEqual([command]);
    expect(result.steps.every(isStepResult)).toBe(true);
  });

  test("waits for a late element by reading it, then clicks once", async () => {
    const clock = fakeClock();
    const late = (read: number) => (read < 4 ? { count: 0 } : {});
    const { driver, calls } = fakeDriver({ elements: { box: late } });
    const step: Step = { id: "late", action: "click", target: BOX };
    const result = await replayFlow(driver, flowOf([step]), { clock });
    expect(calls).toEqual([
      "inspect box",
      "inspect box",
      "inspect box",
      "inspect box",
      "act click",
    ]);
    expect(result.steps[0]).toMatchObject({ status: "passed", attempts: 4 });
    expect(clock.sleeps).toEqual([100, 100, 100]);
  });

  test.each<[string, Partial<Record<string, unknown>>, string, RegExp]>([
    ["a disabled element", { enabled: false }, "timeout", /disabled/],
    ["a hidden element", { visible: false }, "timeout", /hidden/],
    ["two matches", { count: 2 }, "ambiguous", /2 elements match/],
  ])("%s is never clicked and fails the run", async (_name, state, code, message) => {
    const { driver, calls } = fakeDriver({ elements: { box: state } });
    const step: Step = { id: "c", action: "click", target: BOX, timeoutMs: 500 };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(actsOf(calls)).toEqual([]);
    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.steps[0]).toMatchObject({ status: "failed", error: { code } });
    expect(result.steps[0]?.error?.message).toMatch(message);
    expect(result.steps[0]?.attempts).toBe(6);
  });

  test("fill waits for an editable element", async () => {
    const { driver, calls } = fakeDriver({ elements: { box: { editable: false } } });
    const step: Step = { id: "f", action: "fill", target: BOX, value: "x", timeoutMs: 200 };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.steps[0]?.error?.message).toMatch(/not editable/);
    expect(actsOf(calls)).toEqual([]);
  });
});

describe("dispatch outcomes and deadlines", () => {
  test("a write whose effect is unknown is indeterminate, never retried, and stops the run", async () => {
    const unknown = { status: "unknown", code: "timeout", message: "No navigation" } as const;
    const { driver, calls } = fakeDriver({ elements: { box: {} }, act: () => unknown });
    const steps: Step[] = [
      { id: "order", action: "click", target: BOX },
      { id: "after", action: "click", target: BOX },
    ];
    const result = await replayFlow(driver, flowOf(steps), { clock: fakeClock() });
    expect(actsOf(calls)).toEqual(["act click"]);
    expect(result).toMatchObject({ status: "error", exitCode: 2 });
    expect(result.steps).toEqual([
      expect.objectContaining({
        status: "indeterminate",
        error: { code: "timeout", message: "No navigation" },
      }),
    ]);
    expect(result.summary.counts).toMatchObject({ indeterminate: 1, blocked: 1 });
  });

  test("a driver that throws while acting leaves the step indeterminate", async () => {
    const { driver, calls } = fakeDriver({
      elements: { box: {} },
      act: () => Promise.reject(new Error("Target closed")),
    });
    const step: Step = { id: "c", action: "click", target: BOX };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(actsOf(calls)).toEqual(["act click"]);
    expect(result.steps[0]).toMatchObject({
      status: "indeterminate",
      error: { code: "adapter-error", message: "Target closed" },
      attempts: 1,
    });
  });

  test.each<[string, "not-dispatched" | "failed", string, "failed" | "error"]>([
    ["a navigation error", "failed", "navigation-failed", "failed"],
    ["an option that is missing", "not-dispatched", "not-actionable", "failed"],
    ["an adapter error", "failed", "adapter-error", "error"],
  ])("%s fails the step with its code", async (_name, status, code, runStatus) => {
    const { driver, calls } = fakeDriver({ act: () => ({ status, code, message: code }) });
    const step: Step = { id: "go", action: "navigate", url: "http://127.0.0.1:4600/" };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(actsOf(calls)).toEqual(["act navigate"]);
    expect(result.status).toBe(runStatus);
    expect(result.steps[0]).toMatchObject({ status: "failed", error: { code } });
  });

  test("the write gets the time left before the step's deadline", async () => {
    const clock = fakeClock();
    const late = (read: number) => (read < 3 ? { count: 0 } : {});
    const { driver, timeouts } = fakeDriver({ elements: { box: late } });
    const step: Step = { id: "c", action: "click", target: BOX, timeoutMs: 1000 };
    await replayFlow(driver, flowOf([step]), { clock });
    expect(timeouts).toEqual([1000, 900, 800, 800]);
  });

  test("no write is dispatched once the deadline has passed", async () => {
    const clock = fakeClock();
    const { driver, calls } = fakeDriver();
    const slow = { ...driver, inspect: async () => (await clock.sleep(600), elementReady()) };
    const step: Step = { id: "c", action: "click", target: BOX, timeoutMs: 500 };
    const result = await replayFlow(slow, flowOf([step]), { clock });
    expect(actsOf(calls)).toEqual([]);
    expect(result.steps[0]).toMatchObject({ status: "failed", error: { code: "timeout" } });
  });

  test("a step's timeoutMs overrides the flow default", async () => {
    const clock = fakeClock();
    const { driver } = fakeDriver();
    const steps: Step[] = [{ id: "c", action: "click", target: BOX, timeoutMs: 300 }];
    const result = await replayFlow(driver, flowOf(steps), { clock, defaultTimeoutMs: 5000 });
    expect(result.steps[0]?.durationMs).toBe(300);
    const other = fakeClock();
    const { driver: second } = fakeDriver();
    const plain: Step[] = [{ id: "c", action: "click", target: BOX }];
    const run = await replayFlow(second, flowOf(plain), { clock: other, defaultTimeoutMs: 700 });
    expect(run.steps[0]?.durationMs).toBe(700);
  });

  test("the default step timeout is ten seconds", async () => {
    const { driver } = fakeDriver();
    const step: Step = { id: "c", action: "click", target: BOX };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.steps[0]).toMatchObject({ durationMs: 10_000, error: { code: "timeout" } });
  });
});

function elementReady() {
  return { count: 1, visible: true, enabled: true, editable: true, text: "", value: null };
}

describe("tabs", () => {
  const tabs = {
    tabs: [
      { url: "http://127.0.0.1:4600/routes/replay", title: "Replay" },
      { url: "http://127.0.0.1:4600/routes/popup", title: "Popup" },
      { url: "http://127.0.0.1:4601/routes/popup", title: "Popup elsewhere" },
    ],
    current: 0,
  };

  test.each<[string, number | string, number]>([
    ["an index", 2, 2],
    ["an exact URL", "http://127.0.0.1:4600/routes/popup", 1],
    ["an exact title", "Popup", 1],
    ["a unique part of a URL", "4601", 2],
  ])("selectTab finds %s and switches once", async (_name, tab, index) => {
    const { driver, commands } = fakeDriver({ tabs: clone(tabs) });
    const step: Step = { id: "t", action: "selectTab", tab };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.status).toBe("passed");
    expect(commands).toEqual([{ kind: "selectTab", index }]);
  });

  test.each<[string, number | string]>([
    ["an index out of range", 3],
    ["a part several tabs share", "popup"],
    ["text no tab has", "missing"],
  ])("selectTab with %s times out without switching", async (_name, tab) => {
    const { driver, commands } = fakeDriver({ tabs: clone(tabs) });
    const step: Step = { id: "t", action: "selectTab", tab, timeoutMs: 300 };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(commands).toEqual([]);
    expect(result.steps[0]).toMatchObject({ status: "failed", error: { code: "timeout" } });
    expect(result.steps[0]?.error?.message).toContain("Popup elsewhere <http://127.0.0.1:4601");
  });

  test("selectTab waits for a popup to open", async () => {
    const list = clone(tabs);
    const popup = list.tabs.splice(1, 2);
    const { driver } = fakeDriver({ tabs: list });
    const tabsOnce = driver.tabs.bind(driver);
    let reads = 0;
    driver.tabs = async () => {
      reads += 1;
      if (reads === 3) list.tabs.push(...popup);
      return tabsOnce();
    };
    const step: Step = { id: "t", action: "selectTab", tab: "Popup elsewhere" };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.steps[0]).toMatchObject({ status: "passed", attempts: 3 });
  });
});

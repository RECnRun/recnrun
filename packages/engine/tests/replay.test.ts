import { isStepResult, type Flow, type Step, type Target } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { runSteps, type ReplayDriver } from "../src/index.ts";

const STATUS: Target = { testId: "status" };

const SPIKE_STEPS: Step[] = [
  { id: "open", action: "navigate", url: "${env.baseUrl}/routes/form?fail=${env.fail}" },
  {
    id: "fill-name",
    action: "fill",
    target: { role: "textbox", name: "Name", exact: true },
    value: "${inputs.name}",
  },
  { id: "submit", action: "click", target: { role: "button", name: "Submit", exact: true } },
  { id: "read-status", action: "extractText", target: STATUS, saveAs: "status" },
  { id: "status", assertion: "textEquals", target: STATUS, expected: "Submitted ${inputs.name}" },
];

function flowOf(steps: Step[]): Flow {
  return {
    schemaVersion: 1,
    id: "spike",
    name: "Spike",
    actors: {},
    inputs: {},
    requirements: [],
    preconditions: [],
    steps,
  };
}

/** A driver that records each call and shows `text` for every target. */
function fakeDriver(text = "Submitted Ada", failOn?: string) {
  const calls: string[] = [];
  const record = (call: string) => {
    calls.push(call);
    if (failOn && call.startsWith(failOn)) return Promise.reject(new Error(`${failOn} broke`));
    return Promise.resolve();
  };
  const driver: ReplayDriver = {
    navigate: (url) => record(`navigate ${url}`),
    fill: (target, value) => record(`fill ${JSON.stringify(target)} ${value}`),
    click: (target) => record(`click ${JSON.stringify(target)}`),
    readText: async (target) => {
      await record(`readText ${JSON.stringify(target)}`);
      return text;
    },
  };
  return { driver, calls };
}

const OPTIONS = {
  env: { baseUrl: "http://127.0.0.1:4600", fail: "" },
  inputs: { name: "Ada" },
  now: () => new Date("2026-11-02T10:00:00.000Z"),
};

describe("runSteps", () => {
  test("runs every step through the driver and passes", async () => {
    const { driver, calls } = fakeDriver();
    const result = await runSteps(driver, flowOf(SPIKE_STEPS), OPTIONS);
    expect(calls).toEqual([
      "navigate http://127.0.0.1:4600/routes/form?fail=",
      'fill {"role":"textbox","name":"Name","exact":true} Ada',
      'click {"role":"button","name":"Submit","exact":true}',
      'readText {"testId":"status"}',
      'readText {"testId":"status"}',
    ]);
    expect(result.status).toBe("passed");
    expect(result.vars).toEqual({ status: "Submitted Ada" });
    expect(result.steps.map(({ stepId, status }) => [stepId, status])).toEqual(
      SPIKE_STEPS.map(({ id }) => [id, "passed"]),
    );
    expect(result.steps[3]?.evidence).toEqual(['observed: "Submitted Ada"']);
    expect(result.steps[0]).toMatchObject({
      startedAt: "2026-11-02T10:00:00.000Z",
      endedAt: "2026-11-02T10:00:00.000Z",
      durationMs: 0,
    });
    expect(result.steps.every(isStepResult)).toBe(true);
  });

  test("fails the assertion with the expected and observed text as evidence", async () => {
    const { driver } = fakeDriver("Submitted nobody");
    const result = await runSteps(driver, flowOf(SPIKE_STEPS), OPTIONS);
    expect(result.status).toBe("failed");
    expect(result.steps.map(({ status }) => status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "failed",
    ]);
    expect(result.steps[4]).toMatchObject({
      stepId: "status",
      error: { code: "assertion-failed" },
      evidence: ['expected: "Submitted Ada"', 'observed: "Submitted nobody"'],
    });
    expect(result.steps.every(isStepResult)).toBe(true);
  });

  test("runs no step after a failed one", async () => {
    const { driver, calls } = fakeDriver("Other");
    const steps: Step[] = [
      { id: "check", assertion: "textEquals", target: STATUS, expected: "Expected" },
      { id: "after", action: "click", target: STATUS },
    ];
    const result = await runSteps(driver, flowOf(steps), OPTIONS);
    expect(result.status).toBe("failed");
    expect(result.steps.map(({ stepId }) => stepId)).toEqual(["check"]);
    expect(calls).toEqual(['readText {"testId":"status"}']);
  });

  test("an adapter exception is an error, and no later step runs", async () => {
    const { driver, calls } = fakeDriver("Submitted Ada", "click");
    const result = await runSteps(driver, flowOf(SPIKE_STEPS), OPTIONS);
    expect(result.status).toBe("error");
    expect(result.steps.map(({ status }) => status)).toEqual(["passed", "passed", "failed"]);
    expect(result.steps[2]?.error).toEqual({ code: "adapter-error", message: "click broke" });
    expect(calls.at(-1)).toMatch(/^click /);
    expect(result.steps.every(isStepResult)).toBe(true);
  });

  test("a rejection that is not an Error still yields a message", async () => {
    const driver: ReplayDriver = { ...fakeDriver().driver, navigate: () => Promise.reject("") };
    const result = await runSteps(driver, flowOf(SPIKE_STEPS.slice(0, 1)), OPTIONS);
    expect(result.steps[0]?.error).toEqual({ code: "adapter-error", message: "Unknown error." });
  });

  test.each<[string, Step, string]>([
    ["an action the spike lacks", { id: "again", action: "reload" }, "unsupported-step"],
    [
      "an assertion the spike lacks",
      { id: "seen", assertion: "visible", target: STATUS },
      "unsupported-step",
    ],
    ["a control block", { id: "stop", builtin: "break" }, "unsupported-step"],
    [
      "a missing input",
      { id: "go", action: "navigate", url: "${inputs.x}" },
      "unresolved-variable",
    ],
    ["a nested path", { id: "go", action: "navigate", url: "${env.a.b}" }, "unresolved-variable"],
    [
      "an inherited key",
      { id: "go", action: "navigate", url: "${vars.constructor}" },
      "unresolved-variable",
    ],
    ["a secret", { id: "go", action: "navigate", url: "${secrets.token}" }, "unresolved-variable"],
  ])("%s is an error before the driver is called", async (_name, step, code) => {
    const { driver, calls } = fakeDriver();
    const result = await runSteps(driver, flowOf([step]), OPTIONS);
    expect(result.status).toBe("error");
    expect(result.steps[0]).toMatchObject({ status: "failed", error: { code } });
    expect(calls).toEqual([]);
  });

  test("an empty flow passes, and the options have defaults", async () => {
    expect(await runSteps(fakeDriver().driver, flowOf([]))).toEqual({
      status: "passed",
      steps: [],
      vars: {},
    });
  });
});

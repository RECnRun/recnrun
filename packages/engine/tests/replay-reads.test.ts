import { isStepResult, type Step } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { replayFlow } from "../src/index.ts";
import { actsOf, clone, fakeClock, fakeDriver, flowOf, type FakePage } from "./replay-fakes.ts";

const BOX = { testId: "box" };
const URL_NOW = "http://127.0.0.1:4600/routes/replay?q=pears";

const PAGE: FakePage = {
  elements: {
    box: { text: "  Basket:\n 3 pears ", value: "pears" },
    gone: { visible: false },
    off: { enabled: false },
    item: { count: 3 },
  },
  tabs: { tabs: [{ url: URL_NOW, title: "Replay" }], current: 0 },
};

describe("assertions", () => {
  test.each<[string, Step, string]>([
    ["visible", { id: "a", assertion: "visible", target: BOX }, "one element, visible, enabled"],
    ["hidden", { id: "a", assertion: "hidden", target: { testId: "gone" } }, "one element, hidden"],
    ["hidden when absent", { id: "a", assertion: "hidden", target: { testId: "x" } }, "no element"],
    ["enabled", { id: "a", assertion: "enabled", target: BOX }, "enabled"],
    ["disabled", { id: "a", assertion: "disabled", target: { testId: "off" } }, "disabled"],
    [
      "textEquals",
      { id: "a", assertion: "textEquals", target: BOX, expected: "Basket: 3 pears" },
      "Basket:",
    ],
    [
      "textContains",
      { id: "a", assertion: "textContains", target: BOX, expected: "3 ${inputs.fruit}" },
      "3 pears",
    ],
    ["value", { id: "a", assertion: "value", target: BOX, expected: "${inputs.fruit}" }, "pears"],
    ["count", { id: "a", assertion: "count", target: { testId: "item" }, expected: 3 }, "3"],
    ["url", { id: "a", assertion: "url", expected: URL_NOW }, URL_NOW],
    ["url with a wildcard", { id: "a", assertion: "url", expected: "*/routes/replay?*" }, "q="],
  ])("%s passes with what it observed", async (_name, step, observed) => {
    const { driver, calls } = fakeDriver(clone(PAGE));
    const options = { clock: fakeClock(), inputs: { fruit: "pears" } };
    const result = await replayFlow(driver, flowOf([step]), options);
    expect(result.status).toBe("passed");
    expect(result.steps[0]?.evidence?.[0]).toContain(observed);
    expect(result.steps[0]?.attempts).toBe(1);
    expect(actsOf(calls)).toEqual([]);
    expect(result.steps.every(isStepResult)).toBe(true);
  });

  test("an assertion polls until it holds", async () => {
    const changing = (read: number) => ({ text: read < 5 ? "Loading" : "Ready" });
    const { driver } = fakeDriver({ elements: { box: changing } });
    const step: Step = { id: "a", assertion: "textEquals", target: BOX, expected: "Ready" };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.steps[0]).toMatchObject({ status: "passed", attempts: 5 });
  });

  test("a failing assertion fails the run with expected and observed", async () => {
    const { driver } = fakeDriver({ elements: { box: { text: "Loading" } } });
    const steps: Step[] = [
      { id: "a", assertion: "textEquals", target: BOX, expected: "Ready", timeoutMs: 1000 },
      { id: "next", action: "click", target: BOX },
    ];
    const result = await replayFlow(driver, flowOf(steps), { clock: fakeClock() });
    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      status: "failed",
      attempts: 11,
      durationMs: 1000,
      error: { code: "assertion-failed", message: 'Expected "Ready", observed "Loading".' },
      evidence: ['expected: "Ready"', 'observed: "Loading"'],
    });
    expect(result.summary.failures).toEqual([
      {
        stepId: "a",
        message: 'Expected "Ready", observed "Loading".',
        evidence: ['expected: "Ready"', 'observed: "Loading"'],
      },
    ]);
  });

  test.each<[string, Step, string]>([
    ["count", { id: "a", assertion: "count", target: BOX, expected: 2 }, 'observed: "1"'],
    [
      "value of a plain element",
      { id: "a", assertion: "value", target: BOX, expected: "x" },
      "(no value)",
    ],
    [
      "text of no element",
      { id: "a", assertion: "textEquals", target: { testId: "x" }, expected: "y" },
      "(no element matches)",
    ],
    ["visible", { id: "a", assertion: "visible", target: { testId: "x" } }, "no element matches"],
    ["url", { id: "a", assertion: "url", expected: "http://other/" }, "about:blank"],
  ])("a failing %s assertion reports what it saw", async (_name, step, observed) => {
    const { driver } = fakeDriver({ elements: { box: {} } });
    const result = await replayFlow(driver, flowOf([{ ...step, timeoutMs: 100 }]), {
      clock: fakeClock(),
    });
    expect(result.steps[0]?.error?.code).toBe("assertion-failed");
    expect(result.steps[0]?.evidence?.[1]).toContain(observed);
  });

  test("a read that throws is read again", async () => {
    const { driver } = fakeDriver({ elements: { box: { text: "Ready" } } });
    const inspect = driver.inspect.bind(driver);
    let reads = 0;
    driver.inspect = async (target, options) => {
      reads += 1;
      if (reads < 3) throw new Error("Execution context was destroyed");
      return inspect(target, options);
    };
    const step: Step = { id: "a", assertion: "textEquals", target: BOX, expected: "Ready" };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.steps[0]).toMatchObject({ status: "passed", attempts: 3 });
  });

  test("reads that always throw end as an adapter error", async () => {
    const { driver } = fakeDriver();
    driver.inspect = () => Promise.reject(new Error("Target closed"));
    const step: Step = { id: "a", assertion: "visible", target: BOX, timeoutMs: 200 };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result).toMatchObject({ status: "error", exitCode: 2 });
    expect(result.steps[0]).toMatchObject({
      error: { code: "adapter-error", message: "Target closed" },
      attempts: 3,
    });
  });
});

describe("waitFor", () => {
  test.each<[string, Step]>([
    ["visible by default", { id: "w", action: "waitFor", target: BOX }],
    ["hidden", { id: "w", action: "waitFor", target: { testId: "gone" }, state: "hidden" }],
    ["attached", { id: "w", action: "waitFor", target: { testId: "gone" }, state: "attached" }],
    ["detached", { id: "w", action: "waitFor", target: { testId: "x" }, state: "detached" }],
    ["a url", { id: "w", action: "waitFor", url: "*?q=pears" }],
    ["both", { id: "w", action: "waitFor", target: BOX, url: URL_NOW }],
  ])("waits for %s without acting", async (_name, step) => {
    const { driver, calls } = fakeDriver(clone(PAGE));
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.status).toBe("passed");
    expect(actsOf(calls)).toEqual([]);
  });

  test("times out with what it saw", async () => {
    const { driver } = fakeDriver(clone(PAGE));
    const steps: Step[] = [
      { id: "w", action: "waitFor", target: { testId: "gone" }, timeoutMs: 300 },
    ];
    const result = await replayFlow(driver, flowOf(steps), { clock: fakeClock() });
    expect(result.steps[0]).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
      attempts: 4,
    });
    expect(result.steps[0]?.error?.message).toContain("was not visible: one element, hidden");
  });

  test("times out on a URL that never comes", async () => {
    const { driver } = fakeDriver(clone(PAGE));
    const steps: Step[] = [{ id: "w", action: "waitFor", url: "http://other/", timeoutMs: 100 }];
    const result = await replayFlow(driver, flowOf(steps), { clock: fakeClock() });
    expect(result.steps[0]?.error?.message).toContain(`it is ${URL_NOW}`);
  });

  test("needs a target or a url", async () => {
    const { driver } = fakeDriver();
    const result = await replayFlow(driver, flowOf([{ id: "w", action: "waitFor" }]));
    expect(result).toMatchObject({ status: "error", exitCode: 2 });
    expect(result.steps[0]?.error?.code).toBe("invalid-step");
  });
});

describe("extraction", () => {
  test("extractText saves collapsed text that later steps interpolate", async () => {
    const { driver, commands } = fakeDriver(clone(PAGE));
    const steps: Step[] = [
      { id: "read", action: "extractText", target: BOX, saveAs: "basket" },
      { id: "type", action: "fill", target: BOX, value: "${vars.basket}!" },
    ];
    const result = await replayFlow(driver, flowOf(steps), { clock: fakeClock() });
    expect(result.vars).toEqual({ basket: "Basket: 3 pears" });
    expect(result.steps[0]?.evidence).toEqual(['observed: "Basket: 3 pears"']);
    expect(commands).toEqual([{ kind: "fill", target: BOX, value: "Basket: 3 pears!" }]);
  });

  test("extractAttribute waits until the element has the attribute", async () => {
    const page = { ...clone(PAGE), attributes: { box: { "data-sku": null as string | null } } };
    const { driver } = fakeDriver(page);
    const readAttribute = driver.readAttribute.bind(driver);
    let reads = 0;
    driver.readAttribute = async (target, name, options) => {
      reads += 1;
      if (reads === 2) page.attributes.box["data-sku"] = "P-42";
      return readAttribute(target, name, options);
    };
    const step: Step = {
      id: "x",
      action: "extractAttribute",
      target: BOX,
      attribute: "data-sku",
      saveAs: "sku",
    };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.vars).toEqual({ sku: "P-42" });
    expect(result.steps[0]).toMatchObject({ status: "passed", attempts: 3 });
  });

  test.each<[string, FakePage, string]>([
    ["no element", {}, "no element matches"],
    ["no attribute", { elements: { box: {} } }, "has no attribute data-sku"],
  ])("extractAttribute with %s times out", async (_name, page, message) => {
    const { driver } = fakeDriver(page);
    const step: Step = {
      id: "x",
      action: "extractAttribute",
      target: BOX,
      attribute: "data-sku",
      saveAs: "sku",
      timeoutMs: 200,
    };
    const result = await replayFlow(driver, flowOf([step]), { clock: fakeClock() });
    expect(result.steps[0]).toMatchObject({ status: "failed", error: { code: "timeout" } });
    expect(result.steps[0]?.error?.message).toContain(message);
    expect(result.vars).toEqual({});
  });
});

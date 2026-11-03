import { parseStored, type Event, type RunManifest, type Step } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import {
  applySessionEvent,
  createSession,
  pauseSession,
  replayFlow,
  resumeSession,
  type ReplayRunStore,
  type Session,
  type SessionResult,
} from "../src/index.ts";
import { actsOf, fakeClock, fakeDriver, flowOf } from "./replay-fakes.ts";

const BOX = { testId: "box" };
const GO: Step = { id: "go", action: "navigate", url: "http://127.0.0.1:4600/" };
const CLICK: Step = { id: "click", action: "click", target: BOX };
const SEEN: Step = { id: "seen", assertion: "visible", target: BOX };

const MANIFEST: RunManifest = {
  schemaVersion: 1,
  runId: "run-1",
  flowId: "replay",
  flowRevision: "a".repeat(64),
  startedAt: "2026-11-02T10:00:00.000Z",
  captureLevel: "normal",
  versions: { engine: "0.0.0", protocol: 1 },
  bindings: {},
};

function fakeStore() {
  const log: string[] = [];
  const events: Event[] = [];
  let finished: Parameters<ReplayRunStore["finishRun"]>[0] | undefined;
  const store: ReplayRunStore = {
    async createRun(manifest) {
      log.push(`createRun ${manifest.runId}`);
      return {
        journal: {
          append: async (event) => void events.push(event),
          close: async () => void log.push("close"),
        },
      };
    },
    async finishRun(result) {
      log.push("finishRun");
      finished = result;
    },
  };
  return { store, log, events, finished: () => finished };
}

function ok(result: SessionResult): Session {
  if (!result.ok) throw new Error(result.error.code);
  return result.session;
}

describe("run results", () => {
  test("an empty flow passes with exit code 0", async () => {
    const result = await replayFlow(fakeDriver().driver, flowOf([]));
    expect(result).toMatchObject({ status: "passed", exitCode: 0, steps: [], vars: {} });
    expect(result).not.toHaveProperty("error");
  });

  test("stores steps.json and summary.json, and journals each step's start and end", async () => {
    const { store, log, events, finished } = fakeStore();
    const { driver } = fakeDriver({ elements: { box: { visible: false } } });
    const steps: Step[] = [GO, { ...SEEN, timeoutMs: 100 }, CLICK];
    const result = await replayFlow(driver, flowOf(steps), {
      clock: fakeClock(),
      run: { store, manifest: MANIFEST },
    });
    expect(log).toEqual(["createRun run-1", "close", "finishRun"]);
    expect(events.map(({ seq, type, stepId }) => [seq, type, stepId])).toEqual([
      [1, "step.started", "go"],
      [2, "step.finished", "go"],
      [3, "step.started", "seen"],
      [4, "step.finished", "seen"],
    ]);
    expect(events[3]).toMatchObject({
      runId: "run-1",
      source: "engine",
      producer: "engine:replay",
      category: "step",
      payload: { index: 1, status: "failed", error: { code: "assertion-failed" } },
    });
    const stored = finished();
    expect(parseStored("run-steps", stored?.steps)).toMatchObject({ ok: true });
    expect(parseStored("run-summary", stored?.summary)).toMatchObject({ ok: true });
    expect(parseStored("run-coverage", stored?.coverage)).toMatchObject({ ok: true });
    expect(stored?.steps.steps.map(({ stepId, status }) => [stepId, status])).toEqual([
      ["go", "passed"],
      ["seen", "failed"],
      ["click", "blocked"],
    ]);
    expect(stored?.steps.steps[1]).toMatchObject({
      startedAt: "2026-11-02T10:00:00.000Z",
      endedAt: "2026-11-02T10:00:00.100Z",
      attempts: 2,
    });
    expect(stored?.summary).toEqual(result.summary);
    expect(result.summary).toMatchObject({
      runId: "run-1",
      status: "failed",
      exitCode: 1,
      counts: { total: 3, passed: 1, failed: 1, blocked: 1 },
    });
  });

  test("observe sees each event as it is written", async () => {
    const seen: string[] = [];
    const observe = (event: Event) => void seen.push(`${event.type} ${event.stepId}`);
    await replayFlow(fakeDriver().driver, flowOf([GO]), { observe, runId: "r" });
    expect(seen).toEqual(["step.started go", "step.finished go"]);
  });

  test.each<[string, Step[], string]>([
    ["a control block", [GO, { id: "stop", builtin: "break" }], "unsupported-step"],
    ["a missing input", [GO], "missing-input"],
  ])("%s blocks every step before the driver is called", async (_name, steps, code) => {
    const { store, finished } = fakeStore();
    const { driver, calls } = fakeDriver();
    const flow = flowOf(steps, { inputs: { name: { type: "string", required: true } } });
    const result = await replayFlow(driver, flow, { run: { store, manifest: MANIFEST } });
    expect(result).toMatchObject({ status: "error", exitCode: 2, steps: [], error: { code } });
    expect(calls).toEqual([]);
    expect(finished()?.steps.steps.every(({ status }) => status === "blocked")).toBe(true);
    expect(result.summary.failures[0]?.message).toMatch(new RegExp(`^${code}: `));
  });

  test.each<[string, Step, string]>([
    [
      "an unknown variable",
      { id: "g", action: "navigate", url: "${vars.x}" },
      "unresolved-variable",
    ],
    ["a local", { id: "g", action: "navigate", url: "${locals.x}" }, "unresolved-variable"],
    ["a nested path", { id: "g", action: "navigate", url: "${env.a.b}" }, "unresolved-variable"],
    [
      "an inherited key",
      { id: "g", action: "navigate", url: "${vars.constructor}" },
      "unresolved-variable",
    ],
  ])("%s fails its step as an error before acting", async (_name, step, code) => {
    const { driver, calls } = fakeDriver();
    const result = await replayFlow(driver, flowOf([step]), { env: { a: "1" } });
    expect(result).toMatchObject({ status: "error", exitCode: 2 });
    expect(result.steps[0]).toMatchObject({ status: "failed", error: { code } });
    expect(calls).toEqual([]);
  });

  test("inputs come from the dataset, then defaults; secret inputs only from secrets", async () => {
    const { driver, commands } = fakeDriver();
    const flow = flowOf(
      [{ id: "g", action: "navigate", url: "/${inputs.a}/${inputs.b}/${inputs.pin}" }],
      {
        inputs: {
          a: { type: "string", required: false },
          b: { type: "number", required: false, default: 2 },
          pin: { type: "string", secret: true, required: true },
        },
      },
    );
    const options = { inputs: { a: "x", pin: "dataset" }, secrets: { pin: "4321" } };
    const result = await replayFlow(driver, flow, options);
    expect(result.status).toBe("passed");
    expect(commands).toEqual([{ kind: "navigate", url: "/x/2/4321" }]);
  });

  test("a step that needs a second actor is an error", async () => {
    const actors = { a: {}, b: {} };
    const two = flowOf(
      [
        { ...GO, actor: "a" },
        { ...GO, id: "two", actor: "b" },
      ],
      { actors },
    );
    const ghost = flowOf([{ ...GO, actor: "ghost" }], { actors });
    const one = flowOf(
      [
        { ...GO, actor: "a" },
        { ...GO, id: "two" },
      ],
      { actors },
    );
    const { driver, calls } = fakeDriver();
    expect(await replayFlow(driver, two)).toMatchObject({
      error: { code: "multi-actor-unsupported" },
    });
    expect(await replayFlow(driver, ghost)).toMatchObject({
      error: { code: "multi-actor-unsupported" },
    });
    expect(calls).toEqual([]);
    expect((await replayFlow(driver, one)).status).toBe("passed");
  });

  test("never asks the driver for networkidle", async () => {
    const { driver, commands } = fakeDriver({ elements: { box: {} } });
    const steps: Step[] = [
      GO,
      { id: "r", action: "reload" },
      CLICK,
      { id: "w", action: "waitFor", url: "*" },
    ];
    await replayFlow(driver, flowOf(steps), { clock: fakeClock() });
    expect(commands).toHaveLength(3);
    expect(JSON.stringify(commands)).not.toMatch(/networkidle/i);
  });
});

describe("secrets", () => {
  test("never reach steps.json, the journal, the summary, or the returned vars", async () => {
    const { store, events, finished } = fakeStore();
    const page = { elements: { box: { text: "token s3cr3t-value shown", value: "s3cr3t-value" } } };
    const { driver, commands } = fakeDriver(page);
    const steps: Step[] = [
      { id: "fill", action: "fill", target: BOX, value: "${secrets.token}" },
      { id: "read", action: "extractText", target: BOX, saveAs: "shown" },
      { id: "is", assertion: "value", target: BOX, expected: "${secrets.token}" },
      {
        id: "bad",
        assertion: "textEquals",
        target: BOX,
        expected: "${secrets.token}",
        timeoutMs: 100,
      },
    ];
    const result = await replayFlow(driver, flowOf(steps), {
      clock: fakeClock(),
      secrets: { token: "s3cr3t-value" },
      run: { store, manifest: MANIFEST },
    });
    expect(commands[0]).toMatchObject({ value: "s3cr3t-value" });
    expect(result.status).toBe("failed");
    const written = JSON.stringify([events, finished(), result]);
    expect(written).not.toContain("s3cr3t-value");
    expect(written).toContain("[redacted]");
    expect(result.vars).toEqual({ shown: "token [redacted] shown" });
  });
});

describe("pauseReplay", () => {
  const recording = ok(applySessionEvent(createSession(), "start"));

  test("stops before the next step and continues once resumed", async () => {
    let session = recording;
    let resume: () => void = () => undefined;
    let waiting: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (waiting = resolve));
    const { driver, calls } = fakeDriver();
    const control = {
      session: () => session,
      changed: () => {
        waiting();
        return new Promise<void>((resolve) => (resume = resolve));
      },
    };
    driver.act = async (command) => {
      calls.push(`act ${command.kind}`);
      if (calls.length === 1) session = ok(pauseSession(session, "pauseReplay", 1));
      return { status: "done" };
    };
    const steps: Step[] = [GO, { ...GO, id: "two" }];
    const running = replayFlow(driver, flowOf(steps), { control });
    await held;
    expect(calls).toEqual(["act navigate"]);
    session = ok(resumeSession(session, "pauseReplay", 2));
    resume();
    expect(await running).toMatchObject({ status: "passed", exitCode: 0 });
    expect(calls).toEqual(["act navigate", "act navigate"]);
  });

  test("another pause does not hold the replay", async () => {
    const session = ok(pauseSession(recording, "pauseStepCreation", 1));
    const control = { session: () => session, changed: () => Promise.reject(new Error("waited")) };
    const result = await replayFlow(fakeDriver().driver, flowOf([GO]), { control });
    expect(result.status).toBe("passed");
  });

  test("a session that stops while paused cancels the rest and interrupts the run", async () => {
    let session = ok(pauseSession(recording, "pauseReplay", 1));
    const { store, finished } = fakeStore();
    const control = {
      session: () => session,
      changed: async () => void (session = ok(applySessionEvent(session, "stop"))),
    };
    const { driver, calls } = fakeDriver();
    const result = await replayFlow(driver, flowOf([GO, CLICK]), {
      control,
      run: { store, manifest: MANIFEST },
    });
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ status: "interrupted", exitCode: 2 });
    expect(finished()?.steps.steps.map(({ status }) => status)).toEqual(["cancelled", "cancelled"]);
    expect(actsOf(calls)).toEqual([]);
  });
});

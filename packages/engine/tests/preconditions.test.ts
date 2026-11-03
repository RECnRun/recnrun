import type { AdapterEvent, Flow, Precondition, Step } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { replayFlow, type ReplayDriver, type ReplayRunStore } from "../src/index.ts";
import { actsOf, fakeClock, fakeDriver, flowOf, type FakePage } from "./replay-fakes.ts";

const ACCOUNT = "http://127.0.0.1:4600/routes/session";
const LOGIN = `${ACCOUNT}?login`;
const BADGE = { testId: "signed-in" };
const GO: Step = { id: "go", action: "navigate", url: ACCOUNT, actor: "requester" };
const CLICK: Step = { id: "click", action: "click", target: { testId: "box" }, actor: "requester" };

const MANIFEST = {
  schemaVersion: 1,
  runId: "run-1",
  flowId: "replay",
  flowRevision: "a".repeat(64),
  startedAt: "2026-11-02T10:00:00.000Z",
  captureLevel: "normal",
  versions: { engine: "0.0.0", protocol: 1 },
  bindings: {},
} as const;

/** A flow of one declared actor whose steps run only once `check` holds for it. */
function guarded(check: Precondition["check"], extra: Partial<Flow> = {}): Flow {
  return flowOf([GO, CLICK], {
    actors: { requester: {} },
    preconditions: [{ authenticated: "requester", check }],
    ...extra,
  });
}

/** A page whose session expired: every navigation lands on the login page. */
function expired(elements: FakePage["elements"] = {}) {
  const page: FakePage = {
    elements,
    act: (command) => {
      if (command.kind === "navigate") fake.list.tabs[0] = { url: LOGIN, title: "Sign in" };
      return { status: "done" };
    },
  };
  const fake = fakeDriver(page);
  return fake;
}

function storing() {
  let statuses: string[] = [];
  const store: ReplayRunStore = {
    createRun: async () => ({ journal: { append: async () => {}, close: async () => {} } }),
    finishRun: async ({ steps }) => void (statuses = steps.steps.map(({ status }) => status)),
  };
  return { run: { store, manifest: MANIFEST }, statuses: () => statuses };
}

const options = () => ({ clock: fakeClock(), defaultTimeoutMs: 300, ...storing() });

describe("a precondition runs before any step", () => {
  test("an expired session fails the URL check and blocks every step", async () => {
    const { driver, calls, commands } = expired();
    const opts = options();
    const result = await replayFlow(driver, guarded({ url: ACCOUNT }), opts);
    expect(result).toMatchObject({
      status: "error",
      exitCode: 2,
      steps: [],
      error: {
        code: "precondition-failed",
        message: `Precondition authenticated: requester: the URL never matched ${JSON.stringify(ACCOUNT)}; it is ${LOGIN}.`,
      },
    });
    expect(commands).toEqual([{ kind: "navigate", url: ACCOUNT }]);
    expect(actsOf(calls)).toEqual(["act navigate"]);
    expect(opts.statuses()).toEqual(["blocked", "blocked"]);
    expect(result.summary).toMatchObject({
      status: "error",
      counts: { total: 2, blocked: 2 },
      failures: [{ stepId: "go", message: expect.stringMatching(/^precondition-failed: /) }],
    });
  });

  test("a live session passes the URL check and the steps run", async () => {
    const { driver, commands } = fakeDriver({ elements: { box: {} } });
    const flow = guarded(
      { url: "${inputs.base}/routes/session" },
      {
        inputs: { base: { type: "string", required: true } },
      },
    );
    const result = await replayFlow(driver, flow, {
      ...options(),
      inputs: { base: "http://127.0.0.1:4600" },
    });
    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(result.steps.map(({ stepId, status }) => [stepId, status])).toEqual([
      ["go", "passed"],
      ["click", "passed"],
    ]);
    expect(commands.map(({ kind }) => kind)).toEqual(["navigate", "navigate", "click"]);
  });

  test("a wildcard URL is only compared, never navigated to", async () => {
    const tabs = { tabs: [{ url: LOGIN, title: "" }], current: 0 };
    const { driver, calls } = fakeDriver({ elements: { box: {} }, tabs });
    const result = await replayFlow(driver, guarded({ url: `${ACCOUNT}*` }), options());
    expect(result.status).toBe("passed");
    expect(actsOf(calls)).toEqual(["act navigate", "act click"]);
  });

  test("a visible check opens its URL and polls the element until the deadline", async () => {
    const { driver, calls, commands } = expired();
    const opts = options();
    const check = { visible: BADGE, url: ACCOUNT };
    const result = await replayFlow(driver, guarded(check), opts);
    expect(result).toMatchObject({
      status: "error",
      error: {
        code: "precondition-failed",
        message: `Precondition authenticated: requester: ${JSON.stringify(BADGE)} is not visible: no element matches.`,
      },
    });
    expect(commands).toEqual([{ kind: "navigate", url: ACCOUNT }]);
    expect(calls.filter((call) => call === "inspect signed-in").length).toBeGreaterThan(1);
    expect(opts.statuses()).toEqual(["blocked", "blocked"]);
  });

  test("a visible element proves the session on the page already open", async () => {
    const { driver, calls } = fakeDriver({ elements: { "signed-in": {}, box: {} } });
    const result = await replayFlow(driver, guarded({ visible: BADGE }), options());
    expect(result.status).toBe("passed");
    expect(calls[0]).toBe("inspect signed-in");
    expect(actsOf(calls)).toEqual(["act navigate", "act click"]);
  });

  test("a secret in the check never reaches the result", async () => {
    const { driver } = expired();
    const flow = guarded({ url: `${ACCOUNT}?token=\${secrets.token}` });
    const result = await replayFlow(driver, flow, { ...options(), secrets: { token: "s3cr3t" } });
    const written = JSON.stringify(result);
    expect(written).not.toContain("s3cr3t");
    expect(result.error?.message).toContain("[redacted]");
  });
});

describe("a precondition the run cannot check", () => {
  test.each<[string, Flow, string]>([
    [
      "a function check",
      guarded({ functionRef: "auth/is-signed-in@1.0.0" }),
      "unsupported-precondition",
    ],
    [
      "an undeclared actor",
      flowOf([GO], {
        actors: { requester: {} },
        preconditions: [{ authenticated: "ghost", check: { url: ACCOUNT } }],
      }),
      "multi-actor-unsupported",
    ],
    [
      "a second actor",
      guarded(
        { url: ACCOUNT },
        { actors: { requester: {}, approver: {} }, steps: [{ ...GO, actor: "approver" }] },
      ),
      "multi-actor-unsupported",
    ],
    ["an unresolved variable", guarded({ url: "${vars.missing}" }), "unresolved-variable"],
  ])("%s ends the run before the driver is called", async (_name, flow, code) => {
    const { driver, calls } = fakeDriver();
    const opts = options();
    const result = await replayFlow(driver, flow, opts);
    expect(result).toMatchObject({ status: "error", exitCode: 2, steps: [], error: { code } });
    expect(calls).toEqual([]);
    expect(opts.statuses().every((status) => status === "blocked")).toBe(true);
  });

  test("a connection lost during the check interrupts the run", async () => {
    const lost: AdapterEvent = {
      type: "connection.lost",
      seq: 7,
      at: "2026-11-03T10:00:00.050Z",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/x",
      gap: { reason: "connection-lost", startedAt: "2026-11-03T10:00:00.050Z", lastSeq: 6 },
    };
    const listeners = new Set<(event: AdapterEvent) => void>();
    const fake = expired();
    const driver: ReplayDriver = {
      ...fake.driver,
      tabs: async (opts) => {
        for (const listener of listeners) listener(lost);
        return fake.driver.tabs(opts);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const opts = options();
    const result = await replayFlow(driver, guarded({ url: ACCOUNT }), opts);
    expect(result).toMatchObject({ status: "interrupted", exitCode: 2, steps: [] });
    expect(opts.statuses()).toEqual(["cancelled", "cancelled"]);
  });
});

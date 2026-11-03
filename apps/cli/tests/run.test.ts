import { RUN_EXIT_CODES, type Flow, type RunStatus, type RunSummary } from "@recnrun/protocol";
import { ServiceCallError } from "@recnrun/service";
import { expect, test } from "vite-plus/test";
import { runFlow, type RunDeps } from "@/run";

const counts = {
  total: 1,
  pending: 0,
  running: 0,
  passed: 0,
  failed: 0,
  blocked: 0,
  cancelled: 0,
  indeterminate: 0,
};
const summary = (status: RunStatus): RunSummary => ({
  schemaVersion: 1,
  runId: "run-1",
  flowId: "tiny",
  status,
  exitCode: RUN_EXIT_CODES[status],
  startedAt: "2026-11-02T10:00:00.000Z",
  endedAt: "2026-11-02T10:00:01.000Z",
  counts,
  failures: status === "failed" ? [{ stepId: "open", message: "boom" }] : [],
});

const tiny = {
  schemaVersion: 1,
  id: "tiny",
  name: "tiny",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [],
} satisfies Flow;

type Answer = () => unknown;

function setup(answers: Partial<Record<"flow.replay" | "run.summary", Answer>>) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: unknown[] = [];
  let clock = 0;
  const deps: RunDeps = {
    load: async () => tiny,
    connect: async () => ({
      client: {
        call: (async (command: string, params: unknown) => {
          calls.push([command, params]);
          return (answers[command as "flow.replay"] ?? (() => ({ runId: "run-1" })))();
        }) as never,
      },
      close: async () => undefined,
    }),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    pause: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, out, err, calls };
}

const options = { flow: "f", dataset: "default" as string | undefined, timeoutMs: 5000 };

test.each(["passed", "failed", "error", "interrupted"] as const)(
  "a %s run exits with its status code and prints exactly one JSON object",
  async (status) => {
    const { deps, out, err } = setup({ "run.summary": () => summary(status) });
    expect(await runFlow(options, deps)).toBe(RUN_EXIT_CODES[status]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toEqual(summary(status));
    expect(err.join("\n")).toContain("run-1");
  },
);

test("the flow file is imported, then the replay names the flow and the dataset", async () => {
  const { deps, calls } = setup({ "run.summary": () => summary("passed") });
  await runFlow(options, deps);
  expect(calls[0]).toEqual(["flow.import", { flow: tiny }]);
  expect(calls[1]).toEqual(["flow.replay", { flowId: "tiny", dataset: "default" }]);
  expect(calls[2]).toEqual(["run.summary", { runId: "run-1" }]);
});

test("without a dataset the request sends none", async () => {
  const { deps, calls } = setup({ "run.summary": () => summary("passed") });
  await runFlow({ ...options, dataset: undefined }, deps);
  expect(calls[1]).toEqual(["flow.replay", { flowId: "tiny" }]);
});

test("run.summary is polled while the run is unfinished", async () => {
  let asked = 0;
  const { deps, out } = setup({
    "run.summary": () => {
      asked += 1;
      if (asked < 3) throw new ServiceCallError("conflict", "The run is still going.");
      return summary("passed");
    },
  });
  expect(await runFlow(options, deps)).toBe(0);
  expect(asked).toBe(3);
  expect(out).toHaveLength(1);
});

test("a run that never finishes ends as an error at the timeout", async () => {
  const { deps, out, err } = setup({
    "run.summary": () => {
      throw new ServiceCallError("conflict", "The run is still going.");
    },
  });
  expect(await runFlow({ ...options, timeoutMs: 1000 }, deps)).toBe(2);
  expect(out).toEqual([]);
  expect(err.join("\n")).toMatch(/did not finish within 1 s/);
});

test("an invalid flow is an error with the validation message on stderr", async () => {
  const { deps, out, err } = setup({});
  deps.load = async () => {
    throw new Error("f/flow.yaml: not a valid flow (steps: required).");
  };
  expect(await runFlow(options, deps)).toBe(2);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("not a valid flow");
});

test("a service error is an error exit and names the code", async () => {
  const { deps, out, err } = setup({
    "flow.replay": () => {
      throw new ServiceCallError("capability-unavailable", "flow.replay is not available yet.");
    },
  });
  expect(await runFlow(options, deps)).toBe(2);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("capability-unavailable");
});

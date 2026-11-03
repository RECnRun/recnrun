import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { openServiceStateStore } from "../../packages/persistence/src/index.ts";
import { runNode, send, tempHome } from "./helpers.ts";

const FIXTURE = "tests/contract/fixtures/recovery-service.ts";

let home = "";
beforeEach(async () => {
  home = await tempHome();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Reads lines until the replay has a run id and its third click is in flight. */
async function untilInFlight(nextLine: () => Promise<string>) {
  let runId = "";
  let inFlight = false;
  while (runId === "" || !inFlight) {
    const line = await nextLine();
    if (line.startsWith("run ")) runId = line.slice("run ".length);
    if (line === "in-flight") inFlight = true;
  }
  return runId;
}

async function call(command: string, params: unknown) {
  const state = await openServiceStateStore({ home }).readState();
  if (state === undefined) throw new Error("No service state.");
  return send(state.port, {
    headers: { authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ requestId: "r", command, params }),
  });
}

test("a service killed mid-run marks the run interrupted on restart and re-executes nothing", async () => {
  const first = runNode(FIXTURE, [home, "replay"], home);
  const runId = await untilInFlight(first.nextLine);
  first.child.kill("SIGKILL");
  await first.exited;

  const second = runNode(FIXTURE, [home, "serve"], home);
  const lines: string[] = [];
  second.child.stdout?.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  expect(await second.nextLine()).toBe("ready");

  const summary = await call("run.summary", { runId });
  expect(summary.status).toBe(200);
  expect(summary.json).toMatchObject({
    result: {
      runId,
      flowId: "four-clicks",
      status: "interrupted",
      exitCode: 2,
      counts: { total: 4, passed: 2, indeterminate: 1, cancelled: 1 },
      failures: [{ stepId: "click-3" }],
    },
  });

  const gaps = await call("run.queryEvents", { runId, category: "gap" });
  expect(gaps.json).toMatchObject({
    result: { events: [{ type: "producer-restarted", payload: { reason: "producer-restarted" } }] },
  });
  const steps = await call("run.queryEvents", { runId, category: "step" });
  const types = (steps.json as { result: { events: { type: string; stepId?: string }[] } }).result
    .events;
  expect(types.map(({ type, stepId }) => `${type} ${stepId ?? ""}`)).toEqual([
    "step.started click-1",
    "step.finished click-1",
    "step.started click-2",
    "step.finished click-2",
    "step.started click-3",
  ]);

  // A second restart finds the run already summarized and changes nothing.
  second.child.kill("SIGTERM");
  expect(await second.exited).toBe(0);
  const third = runNode(FIXTURE, [home, "serve"], home);
  expect(await third.nextLine()).toBe("ready");
  const again = await call("run.queryEvents", { runId, category: "gap" });
  expect((again.json as { result: { events: unknown[] } }).result.events).toHaveLength(1);
  expect(lines.join("")).not.toContain("dispatch");
}, 30_000);

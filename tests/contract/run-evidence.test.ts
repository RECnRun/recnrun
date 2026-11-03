import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { startService, type RunningService } from "../../apps/service/src/index.ts";
import type { CaptureSink, ReplayDriver } from "../../packages/engine/src/index.ts";
import type { CapturedEvent, Event } from "../../packages/protocol/src/index.ts";
import { fakeChrome } from "./fake-chrome.ts";
import { command, tempHome } from "./helpers.ts";

const API = "http://127.0.0.1:4600/api/json";
const FLOW = {
  schemaVersion: 1,
  id: "fetch-json",
  name: "Fetch the fixture JSON",
  steps: [
    { id: "open", action: "navigate", url: "http://127.0.0.1:4600/routes/network" },
    { id: "fetch", action: "click", target: { testId: "fetch-json" } },
    { id: "result", assertion: "visible", target: { testId: "result-json" } },
  ],
};

function network(sink: CaptureSink, seq: number, type: string, payload: object): void {
  sink.event({
    schemaVersion: 1,
    id: `cdp:S1#${seq}`,
    runId: sink.runId,
    seq,
    source: "S1",
    producer: "cdp:S1",
    timestamp: new Date().toISOString(),
    component: "browser",
    targetId: "page-1",
    frameId: "page-1",
    documentId: null,
    category: type === "log" ? "console" : "network",
    type,
    payload: { requestId: "R1", ...payload },
  } as CapturedEvent);
}

/** The fixture page as the adapter captures it: the click fetches the API, answered while the next step reads. */
function capturingDriver(status: () => number): ReplayDriver {
  const visible = {
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    text: "",
    value: null,
  };
  let sink: CaptureSink | undefined;
  let pending = false;
  return {
    inspect: async () => {
      if (sink && pending) {
        network(sink, 3, "response", { url: API, status: status(), mimeType: "application/json" });
        pending = false;
      }
      return visible;
    },
    readAttribute: async () => null,
    tabs: async () => ({ tabs: [{ url: API, title: "" }], current: 0 }),
    act: async (step) => {
      if (sink && step.kind === "click") {
        network(sink, 1, "request", { url: API, method: "GET", resourceType: "Fetch" });
        network(sink, 2, "log", { level: "log", text: "fetching" });
        pending = true;
      }
      return { status: "done" };
    },
    onCapture: async (given) => {
      sink = given;
      return { drain: async () => void (sink = undefined) };
    },
  };
}

let home = "";
let service: RunningService;
let status = 200;
beforeAll(async () => {
  home = await tempHome();
  const adapter = {
    ...fakeChrome().adapter,
    replayDriver: async () => ({ driver: capturingDriver(() => status), close: async () => {} }),
  };
  const started = await startService({ home, adapter });
  if (started.reused) throw new Error(`A service already runs for ${home}.`);
  service = started.service;
  expect(await call("flow.import", { flow: FLOW })).toMatchObject({ ok: true });
});
afterAll(async () => {
  await service.stop();
  await rm(home, { recursive: true, force: true });
});

let next = 0;
async function call(name: string, params: unknown) {
  next += 1;
  const { json } = await command(service, { requestId: `e-${next}`, command: name, params });
  return json as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
}

async function replay(): Promise<string> {
  const started = await call("flow.replay", { flowId: FLOW.id });
  const runId = String(started.result?.["runId"]);
  await expect.poll(async () => (await call("run.summary", { runId })).ok).toBe(true);
  return runId;
}

test("a replay journals its network and console events under the step that caused them", async () => {
  status = 200;
  const runId = await replay();
  const { result } = await call("run.queryEvents", {
    runId,
    types: ["request", "response", "log"],
  });
  const events = (result?.["events"] ?? []) as Event[];
  expect(
    events.map(({ type, stepId, causalConfidence }) => ({ type, stepId, causalConfidence })),
  ).toEqual([
    { type: "request", stepId: "fetch", causalConfidence: "temporal-only" },
    { type: "log", stepId: "fetch", causalConfidence: "temporal-only" },
    { type: "response", stepId: "fetch", causalConfidence: "network-id" },
  ]);
  const folder = join(home, ".recnrun", "flows", FLOW.id, "runs", runId);
  const coverage = JSON.parse(await readFile(join(folder, "coverage.json"), "utf8")) as {
    surfaces: { surface: string; events: number }[];
  };
  expect(coverage.surfaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ surface: "network", events: 2 }),
      expect.objectContaining({ surface: "console-errors", events: 1 }),
    ]),
  );
});

test("run.compare names the 500 response at the step that sent the request", async () => {
  status = 200;
  const baselineRunId = await replay();
  status = 500;
  const runId = await replay();
  const { result } = await call("run.compare", { baselineRunId, runId });
  expect(result?.["divergence"]).toMatchObject({
    kind: "application",
    reason: "network-status",
    stepId: "fetch",
    index: 1,
    baseline: { url: API, httpStatus: 200 },
    run: { url: API, httpStatus: 500 },
  });
});

import {
  coverageOf,
  type CapturedEvent,
  type Event,
  type RunCoverage,
  type RunManifest,
} from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { replayFlow, type CaptureSink, type ReplayBlobs, type ReplayDriver } from "../src/index.ts";
import { fakeClock, fakeDriver, flowOf } from "./replay-fakes.ts";

const PIN = "pin-4471";
const MANIFEST: RunManifest = {
  schemaVersion: 1,
  runId: "run-evidence",
  flowId: "replay",
  flowRevision: "c".repeat(64),
  startedAt: "2026-11-03T10:00:00.000Z",
  captureLevel: "normal",
  versions: { engine: "0.0.0", protocol: 1 },
  bindings: {},
};

function captured(
  seq: number,
  category: string,
  type: string,
  payload: Record<string, unknown>,
): CapturedEvent {
  return {
    schemaVersion: 1,
    id: `cdp:S1#${seq}`,
    runId: "run-evidence",
    seq,
    source: "S1",
    producer: "cdp:S1",
    timestamp: "2026-11-03T10:00:00.100Z",
    component: "browser",
    targetId: "page-1",
    frameId: "page-1",
    documentId: null,
    category,
    type,
    payload,
  } as CapturedEvent;
}

const URL = "http://127.0.0.1:4600/api/json";

/** A driver whose click sends a request; the response comes while the next step reads, the body at drain. */
function capturingDriver() {
  const { driver } = fakeDriver({ elements: { "fetch-json": {}, result: { text: "500" } } });
  let sink: CaptureSink | undefined;
  const deliver = (event: CapturedEvent) => sink?.event(event);
  let drained = false;
  const capturing: ReplayDriver = {
    ...driver,
    act: async (command, options) => {
      if (command.kind === "click") {
        deliver(captured(1, "network", "request", { requestId: "r1", url: URL, postData: PIN }));
        deliver(captured(2, "console", "log", { level: "log", text: `sent ${PIN}` }));
      }
      return driver.act(command, options);
    },
    inspect: async (target, options) => {
      const reads = JSON.stringify(target).includes("result");
      if (reads)
        deliver(captured(3, "network", "response", { requestId: "r1", url: URL, status: 500 }));
      return driver.inspect(target, options);
    },
    onCapture: async (given) => {
      sink = given;
      return {
        drain: async () => {
          await given.blobs?.put(`{"echo":"${PIN}"}`, {
            mime: "application/json",
            encoding: "utf8",
          });
          deliver(captured(4, "network", "finished", { requestId: "r1" }));
          drained = true;
          sink = undefined;
        },
      };
    },
  };
  return { driver: capturing, sinkOf: () => sink, drained: () => drained };
}

function memoryStore() {
  const events: Event[] = [];
  const bodies: (string | Uint8Array)[] = [];
  let closed = false;
  let coverage: RunCoverage | undefined;
  const blobs: ReplayBlobs = {
    put: async (content) => {
      bodies.push(content);
      return { condition: "unavailable", reason: "capture-failed" } as never;
    },
  };
  const store = {
    createRun: async () => ({
      journal: {
        append: async (event: Event) => {
          if (closed) throw new Error("The journal is closed.");
          events.push(event);
        },
        close: async () => void (closed = true),
      },
      blobs,
    }),
    finishRun: async (result: { coverage: RunCoverage }) => void (coverage = result.coverage),
  };
  return { store, events, bodies, coverage: () => coverage };
}

const FLOW = flowOf(
  [
    { id: "open", action: "navigate", url: "http://127.0.0.1:4600/routes/network" },
    { id: "fetch", action: "click", target: { testId: "fetch-json" } },
    { id: "result", assertion: "textContains", target: { testId: "result" }, expected: "500" },
  ],
  { inputs: { pin: { type: "string", required: true, secret: true } } },
);

test("a replay journals what its tabs did under the step that caused it, with secrets redacted", async () => {
  const { driver, drained } = capturingDriver();
  const { store, events, bodies, coverage } = memoryStore();
  const outcome = await replayFlow(driver, FLOW, {
    clock: fakeClock(),
    secrets: { pin: PIN },
    run: { store, manifest: MANIFEST },
  });
  expect(outcome.summary).toMatchObject({ status: "passed", failures: [] });
  expect(drained(), "the capture drains before the journal closes").toBe(true);
  const evidence = events.filter(({ category }) => category !== "step");
  expect(
    evidence.map(({ type, stepId, causalConfidence }) => [type, stepId, causalConfidence]),
  ).toEqual([
    ["request", "fetch", "temporal-only"],
    ["log", "fetch", "temporal-only"],
    ["response", "fetch", "network-id"],
    ["finished", "fetch", "network-id"],
  ]);
  expect(JSON.stringify(events)).not.toContain(PIN);
  expect(evidence[0]?.payload).toMatchObject({ postData: "[redacted]" });
  expect(bodies).toEqual(['{"echo":"[redacted]"}']);
  expect(coverage()).toEqual(coverageOf("run-evidence", events));
});

test("a run that cannot start never starts the capture", async () => {
  const { driver, sinkOf } = capturingDriver();
  const outcome = await replayFlow(driver, FLOW, { clock: fakeClock() });
  expect(outcome.status).toBe("error");
  expect(sinkOf()).toBeUndefined();
});

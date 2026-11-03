import {
  coverageOf,
  type AdapterEvent,
  type Event,
  type RunCoverage,
  type RunManifest,
} from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { replayFlow, type ReplayDriver } from "../src/index.ts";
import { fakeClock, fakeDriver, flowOf } from "./replay-fakes.ts";

const MANIFEST: RunManifest = {
  schemaVersion: 1,
  runId: "run-lost",
  flowId: "replay",
  flowRevision: "b".repeat(64),
  startedAt: "2026-11-03T10:00:00.000Z",
  captureLevel: "normal",
  versions: { engine: "0.0.0", protocol: 1 },
  bindings: {},
};

const LOST: AdapterEvent = {
  type: "connection.lost",
  seq: 3,
  at: "2026-11-03T10:00:00.050Z",
  endpoint: "ws://127.0.0.1:9222/devtools/browser/x",
  gap: { reason: "connection-lost", startedAt: "2026-11-03T10:00:00.050Z", lastSeq: 2 },
};

/** A driver whose connection drops during the first read, as Chrome killed mid-run would. */
function droppingDriver() {
  const listeners = new Set<(event: AdapterEvent) => void>();
  const { driver } = fakeDriver();
  let dropped = false;
  const dropping: ReplayDriver = {
    ...driver,
    inspect: async (target, options) => {
      if (!dropped) for (const listener of listeners) listener(LOST);
      dropped = true;
      return driver.inspect(target, options);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { driver: dropping, listeners };
}

function memoryStore() {
  const events: Event[] = [];
  let coverage: RunCoverage | undefined;
  const store = {
    createRun: async () => ({
      journal: { append: async (event: Event) => void events.push(event), close: async () => {} },
    }),
    finishRun: async (result: { coverage: RunCoverage }) => void (coverage = result.coverage),
  };
  return { store, events, coverage: () => coverage };
}

test("a lost connection is journaled as the adapter's gap, and coverage.json reconciles with the journal", async () => {
  const { driver, listeners } = droppingDriver();
  const { store, events, coverage } = memoryStore();
  const steps = [
    { id: "seen", assertion: "visible" as const, target: { testId: "box" }, timeoutMs: 50 },
  ];
  const result = await replayFlow(driver, flowOf(steps), {
    clock: fakeClock(),
    run: { store, manifest: MANIFEST },
  });
  expect(result.status).toBe("failed");
  expect(events.filter(({ category }) => category === "gap")).toEqual([
    {
      schemaVersion: 1,
      id: "adapter:connection#3",
      runId: "run-lost",
      seq: 3,
      source: "adapter",
      producer: "adapter:connection",
      timestamp: LOST.at,
      component: "collector",
      targetId: null,
      frameId: null,
      documentId: null,
      category: "gap",
      type: "connection-lost",
      payload: { reason: "connection-lost", startedAt: LOST.at, lastSeq: 2 },
    },
  ]);
  expect(coverage()).toEqual(coverageOf("run-lost", events));
  expect(coverage()?.gaps).toEqual([{ reason: "connection-lost", gaps: 1, lostEvents: 0 }]);
  expect(listeners.size, "the run stops listening when it ends").toBe(0);
});

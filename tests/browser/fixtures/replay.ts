import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCdpAdapter } from "../../../packages/adapter/src/index.ts";
import {
  replayFlow,
  type ReplayOptions,
  type ReplayOutcome,
} from "../../../packages/engine/src/index.ts";
import {
  openFlowStore,
  type FlowStore,
  type StoredRun,
} from "../../../packages/persistence/src/index.ts";
import { validateFlow, type Flow, type Step } from "../../../packages/protocol/src/index.ts";

export interface Replayed {
  outcome: ReplayOutcome;
  /** The run as the flow store holds it after the replay: manifest, steps, summary, journal. */
  stored: StoredRun;
  /** Every blob the run's events reference, by sha256, read back before the store is removed. */
  blobs: ReadonlyMap<string, Buffer>;
}

async function readBlobs(store: FlowStore, { manifest, journal }: StoredRun) {
  const blobs = new Map<string, Buffer>();
  for (const { payload } of journal.events) {
    for (const value of Object.values(payload)) {
      const sha256 = (value as { sha256?: unknown } | null)?.sha256;
      if (typeof sha256 !== "string" || blobs.has(sha256)) continue;
      blobs.set(sha256, await store.readRunBlob(manifest.flowId, manifest.runId, sha256));
    }
  }
  return blobs;
}

function checkedFlow(value: unknown): Flow {
  const parsed = validateFlow(value);
  if (!parsed.ok) throw new Error(`The flow is invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.flow;
}

/** Reads and validates a flow from `tests/browser/fixtures`. */
export function loadFlow(name: string): Flow {
  const file = new URL(`./${name}`, import.meta.url);
  return checkedFlow(JSON.parse(readFileSync(file, "utf8")));
}

/** A flow of `steps`, with no actors or inputs unless `extra` gives them, validated like a flow file. */
export function flowOf(id: string, steps: Step[], extra: Partial<Flow> = {}): Flow {
  return checkedFlow({
    schemaVersion: 1,
    id,
    name: id,
    actors: {},
    inputs: {},
    requirements: [],
    preconditions: [],
    steps,
    ...extra,
  });
}

/**
 * Saves the flow in a temporary flow store, replays it through the CDP adapter into a run of
 * that store, and reads the run back. `whileConnected` runs before the adapter disconnects.
 */
export async function replayStored(
  wsEndpoint: string,
  flow: Flow,
  options: Omit<ReplayOptions, "run" | "runId"> = {},
  whileConnected?: (outcome: ReplayOutcome) => Promise<void>,
): Promise<Replayed> {
  const home = await mkdtemp(join(tmpdir(), "recnrun-replay-"));
  const store = await openFlowStore({ home });
  const adapter = createCdpAdapter();
  try {
    const { revision } = await store.saveFlow(flow);
    const manifest = {
      schemaVersion: 1,
      runId: "run-1",
      flowId: flow.id,
      flowRevision: revision,
      startedAt: new Date().toISOString(),
      captureLevel: "normal",
      versions: { engine: "0.0.0", protocol: 1 },
      bindings: {},
    } as const;
    await adapter.connect(wsEndpoint);
    const outcome = await replayFlow(adapter, flow, { ...options, run: { store, manifest } });
    await whileConnected?.(outcome);
    const stored = await store.getRun(flow.id, manifest.runId);
    return { outcome, stored, blobs: await readBlobs(store, stored) };
  } finally {
    await adapter.disconnect();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
}

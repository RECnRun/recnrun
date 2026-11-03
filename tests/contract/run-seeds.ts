import {
  openFlowStore,
  type BlobStore,
  type FlowStore,
} from "../../packages/persistence/src/index.ts";
import type { Event, Flow, RunSummary, StepResult } from "../../packages/protocol/src/index.ts";

export const SAVE = "http://127.0.0.1:4600/api/save";
export const ASSET = "http://127.0.0.1:4601/logo.png";

/** Navigate, submit, then assert: the submit step sends one request to each fixture origin. */
const saveFlow: Flow = {
  schemaVersion: 1,
  id: "save-form",
  name: "Save the form",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [
    { id: "open", action: "navigate", url: "http://127.0.0.1:4600/routes/form" },
    { id: "submit", action: "click", target: { testId: "submit" } },
    { id: "status", assertion: "textEquals", target: { testId: "status" }, expected: "Saved" },
  ],
};

/** How a seeded run differs from a clean one. */
export interface RunVariant {
  saveStatus?: number;
  gap?: boolean;
  statusFails?: boolean;
  // The HTML of a failure snapshot of `status`, stored as a blob of the run.
  snapshot?: string;
}

const FAILED_ASSERTION = { code: "assertion-failed", message: 'status: expected "Saved"' };

/** The journal of a run of `saveFlow`: one second per event, the page events on profile `work`. */
export function runEvents(runId: string, variant: RunVariant): Event[] {
  const lines: Omit<Event, "schemaVersion" | "id" | "runId" | "seq" | "timestamp">[] = [];
  const page = { targetId: "t-1", frameId: "f-1", documentId: "d-1", profileBinding: "work" };
  const none = { targetId: null, frameId: null, documentId: null };
  const step = (stepId: string, index: number, type: string, payload: Record<string, unknown>) =>
    lines.push({
      ...none,
      source: "engine",
      producer: "engine:replay",
      stepId,
      category: "step",
      type,
      payload: { index, ...payload },
    });
  const response = (stepId: string, url: string, status: number) =>
    lines.push({
      ...page,
      source: "cdp",
      producer: "cdp:network",
      stepId,
      category: "network",
      type: "response",
      payload: { requestId: url, url, status, statusText: "", mimeType: "application/json" },
    });
  for (const [index, stepId] of ["open", "submit", "status"].entries()) {
    step(stepId, index, "step.started", {});
    if (stepId === "submit") {
      response(stepId, SAVE, variant.saveStatus ?? 200);
      response(stepId, ASSET, 200);
    }
    if (stepId === "submit" && variant.gap)
      lines.push({
        ...none,
        source: "cdp",
        producer: "cdp:network",
        component: "collector",
        stepId,
        category: "gap",
        type: "buffer-exhausted",
        payload: { reason: "buffer-exhausted", surface: "network", lost: 2 },
      });
    const failed = stepId === "status" && variant.statusFails;
    step(stepId, index, "step.finished", {
      status: failed ? "failed" : "passed",
      ...(failed && { error: FAILED_ASSERTION }),
    });
  }
  const seqs = new Map<string, number>();
  return lines.map((line, at) => {
    const seq = (seqs.get(line.producer) ?? 0) + 1;
    seqs.set(line.producer, seq);
    const timestamp = new Date(Date.UTC(2026, 10, 2, 10, 0, at)).toISOString();
    return { schemaVersion: 1, id: `${line.producer}#${seq}`, runId, seq, timestamp, ...line };
  }) as Event[];
}

function stepResults(variant: RunVariant): StepResult[] {
  return saveFlow.steps.map(({ id }) =>
    id === "status" && variant.statusFails
      ? { stepId: id, status: "failed", error: FAILED_ASSERTION }
      : { stepId: id, status: "passed" },
  );
}

/** A PNG signature: enough bytes for a binary blob. */
export const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The replay's failure snapshot of `status`, after the six step events of `engine:replay`. */
async function failureSnapshot(blobs: BlobStore, runId: string, html: string): Promise<Event> {
  const dom = await blobs.put(html, { mime: "text/html", encoding: "utf8" });
  const screenshot = await blobs.put(PNG, { mime: "image/png", encoding: "binary" });
  return {
    schemaVersion: 1,
    id: "engine:replay#7",
    runId,
    seq: 7,
    timestamp: "2026-11-02T10:00:59.000Z",
    source: "engine",
    producer: "engine:replay",
    targetId: null,
    frameId: null,
    documentId: null,
    stepId: "status",
    category: "snapshot",
    type: "captured",
    payload: { milestone: "failure", url: "http://127.0.0.1:4600/routes/form", dom, screenshot },
  };
}

async function seedRun(store: FlowStore, revision: string, runId: string, variant: RunVariant) {
  const startedAt = "2026-11-02T10:00:00.000Z";
  const run = await store.createRun({
    schemaVersion: 1,
    runId,
    flowId: saveFlow.id,
    flowRevision: revision,
    startedAt,
    captureLevel: "normal",
    versions: { engine: "0.0.0", protocol: 1 },
    bindings: {},
  });
  for (const event of runEvents(runId, variant)) await run.journal.append(event);
  if (variant.snapshot !== undefined)
    await run.journal.append(await failureSnapshot(run.blobs, runId, variant.snapshot));
  await run.journal.close();
  const steps = stepResults(variant);
  const failed = steps.filter(({ status }) => status === "failed");
  const summary: RunSummary = {
    schemaVersion: 1,
    runId,
    flowId: saveFlow.id,
    status: failed.length > 0 ? "failed" : "passed",
    exitCode: failed.length > 0 ? 1 : 0,
    startedAt,
    endedAt: "2026-11-02T10:01:00.000Z",
    counts: {
      total: 3,
      pending: 0,
      running: 0,
      passed: 3 - failed.length,
      failed: failed.length,
      blocked: 0,
      cancelled: 0,
      indeterminate: 0,
    },
    failures: failed.map(({ stepId }) => ({ stepId, message: FAILED_ASSERTION.message })),
  };
  const entries = { schemaVersion: 1, runId } as const;
  await store.finishRun({
    summary,
    steps: { ...entries, steps },
    coverage: { ...entries, surfaces: [] },
  });
}

/** Saves `saveFlow` under `home` and one finished run per variant. */
export async function seedRuns(home: string, runs: Record<string, RunVariant>) {
  const store = await openFlowStore({ home });
  try {
    const { revision } = await store.saveFlow(saveFlow);
    for (const [runId, variant] of Object.entries(runs))
      await seedRun(store, revision, runId, variant);
  } finally {
    store.close();
  }
}

import type { Event, GapPayload, StepResult } from "@recnrun/protocol";
import type { StoredRun } from "../src/index.ts";
import { runManifest, runSummary } from "./flow-fixtures.ts";

type Line = Omit<Event, "schemaVersion" | "id" | "runId" | "seq" | "timestamp">;

const NO_PAGE = { targetId: null, frameId: null, documentId: null };

export const started = (stepId: string): Line =>
  ({
    ...NO_PAGE,
    source: "engine",
    producer: "engine:replay",
    stepId,
    category: "step",
    type: "step.started",
    payload: {},
  }) as Line;

export const finished = (stepId: string, status: string, code?: string): Line =>
  ({
    ...started(stepId),
    type: "step.finished",
    payload: { status, ...(code && { error: { code, message: `${code} at ${stepId}` } }) },
  }) as Line;

const NETWORK = {
  targetId: "t-1",
  frameId: "f-1",
  documentId: "d-1",
  source: "cdp",
  producer: "cdp:network",
  category: "network",
} as const;

/** A network request; `stepId` is left out so the event belongs to the step that last started. */
export const request = (requestId: string, url: string, method: string): Line =>
  ({
    ...NETWORK,
    profileBinding: "work",
    type: "request",
    payload: { requestId, url, method },
  }) as Line;

/** A network response, to the request `requestId` when given. */
export const response = (
  url: string,
  status: number,
  profileBinding = "work",
  requestId = url,
): Line =>
  ({ ...NETWORK, profileBinding, type: "response", payload: { requestId, url, status } }) as Line;

export const gap = (payload: GapPayload): Line =>
  ({
    ...NO_PAGE,
    source: "cdp",
    producer: "cdp:network",
    component: "collector",
    category: "gap",
    type: payload.reason,
    payload,
  }) as Line;

/** Journal events one second apart, numbered per producer. */
export function journal(runId: string, lines: readonly Line[]): Event[] {
  const seqs = new Map<string, number>();
  return lines.map((line, at) => {
    const seq = (seqs.get(line.producer) ?? 0) + 1;
    seqs.set(line.producer, seq);
    const timestamp = new Date(Date.UTC(2026, 10, 2, 10, 0, at)).toISOString();
    return { schemaVersion: 1, id: `${line.producer}#${seq}`, runId, seq, timestamp, ...line };
  }) as Event[];
}

/** A stored run; with `steps` it ended (steps.json and summary.json), without it is still open. */
export function storedRun(
  runId: string,
  lines: readonly Line[],
  steps?: StepResult[],
  revision = "a".repeat(64),
): StoredRun {
  const events = journal(runId, lines);
  if (steps === undefined) return { manifest: runManifest(revision, runId), journal: { events } };
  return {
    manifest: runManifest(revision, runId),
    steps: { schemaVersion: 1, runId, steps },
    summary: runSummary(runId),
    journal: { events },
  };
}

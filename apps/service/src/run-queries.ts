import {
  BlobStoreError,
  compareRuns,
  pageRunEvents,
  type BlobStoreErrorCode,
  type RunEventFilter,
} from "@recnrun/persistence";
import {
  BodyRefSchema,
  type Artifact,
  type BodyRef,
  type Event,
  type RunComparison,
  type ServiceError,
} from "@recnrun/protocol";
import * as v from "valibot";
import { ServiceFailure } from "./dispatch.ts";
import { flowOfRun, type RunDeps } from "./runs.ts";

const DEFAULT_LIMIT = 100;

export interface EventQuery extends RunEventFilter {
  runId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

const badCursor = () =>
  new ServiceFailure("invalid-request", "The cursor is not one this service returned.");

async function storedRun(deps: RunDeps, runId: string) {
  return deps.store().getRun(await flowOfRun(deps, runId), runId);
}

/** A page of the run's journal; `nextCursor` is the journal position of the next match. */
export async function queryEvents(
  deps: RunDeps,
  { runId, cursor, limit, ...filter }: EventQuery,
): Promise<{ events: Event[]; nextCursor?: string }> {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!/^\d+$/.test(cursor ?? "0") || !Number.isSafeInteger(start)) throw badCursor();
  const { journal } = await storedRun(deps, runId);
  const page = pageRunEvents(journal.events, filter, { start, limit: limit ?? DEFAULT_LIMIT });
  if (page === undefined) throw badCursor();
  return page.next === undefined
    ? { events: page.events }
    : { events: page.events, nextCursor: String(page.next) };
}

/** Both runs aligned step by step, with where they first diverge. */
export async function compare(
  deps: RunDeps,
  { baselineRunId, runId }: { baselineRunId: string; runId: string },
): Promise<RunComparison> {
  const baseline = await storedRun(deps, baselineRunId);
  const run = await storedRun(deps, runId);
  if (baseline.manifest.flowId !== run.manifest.flowId)
    throw new ServiceFailure(
      "invalid-request",
      `Run ${runId} replays ${run.manifest.flowId}, not ${baseline.manifest.flowId}.`,
    );
  return compareRuns(baseline, run);
}

export interface ArtifactRequest {
  runId: string;
  sha256: string;
}

const isRef = (value: unknown): value is BodyRef => v.is(BodyRefSchema, value);

/** The blob reference with this `sha256` among the payload fields of the run's events. */
function referenced(events: readonly Event[], sha256: string): BodyRef | undefined {
  for (const { payload } of events) {
    const found = Object.values(payload).find((value) => isRef(value) && value.sha256 === sha256);
    if (found) return found as BodyRef;
  }
  return undefined;
}

const BLOB_CODES: Record<BlobStoreErrorCode, ServiceError["code"]> = {
  "not-found": "not-found",
  "invalid-name": "invalid-request",
  corrupt: "internal",
};

async function blobOf(deps: RunDeps, flowId: string, { runId, sha256 }: ArtifactRequest) {
  try {
    return await deps.store().readRunBlob(flowId, runId, sha256);
  } catch (error) {
    if (!(error instanceof BlobStoreError)) throw error;
    // The store's message names a path under the user's home, which a client has no use for.
    throw new ServiceFailure(
      BLOB_CODES[error.code],
      `Run ${runId} has no readable blob ${sha256}.`,
    );
  }
}

/** One blob of the run, only when one of the run's own events references it. */
export async function getArtifact(deps: RunDeps, request: ArtifactRequest): Promise<Artifact> {
  const { manifest, journal } = await storedRun(deps, request.runId);
  const ref = referenced(journal.events, request.sha256);
  if (!ref)
    throw new ServiceFailure("not-found", `No event of run ${request.runId} references that blob.`);
  const bytes = await blobOf(deps, manifest.flowId, request);
  const data = ref.encoding === "utf8" ? bytes.toString("utf8") : bytes.toString("base64");
  return { sha256: ref.sha256, mime: ref.mime, encoding: ref.encoding, size: bytes.length, data };
}

import type { CapturedEvent, Event } from "@recnrun/protocol";
import type { CaptureHandle, ReplayDriver } from "./driver.ts";
import type { Recorder, ReplayBlobs } from "./record.ts";
import { redact } from "./scope.ts";

/** A value with every secret replaced in its strings; keys and nesting are kept. */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]),
  );
}

const redactEvent = (event: Event, secrets: readonly string[]): Event =>
  secrets.length === 0
    ? event
    : ({ ...event, payload: redactDeep(event.payload, secrets) } as Event);

// The adapter hands text bodies over as strings, so a secret a response echoes is redacted too.
function redactingBlobs(
  blobs: ReplayBlobs | undefined,
  secrets: readonly string[],
): ReplayBlobs | undefined {
  if (!blobs || secrets.length === 0) return blobs;
  return {
    put: (content, meta) =>
      blobs.put(typeof content === "string" ? redact(content, secrets) : content, meta),
  };
}

function requestKey(event: CapturedEvent): string | undefined {
  if (event.category !== "network") return undefined;
  const requestId = event.payload["requestId"];
  return typeof requestId === "string" ? `${event.source} ${requestId}` : undefined;
}

/**
 * Ties each captured event to a step: a request's later events (response, body, failure) to the
 * step its request came in, by request id; anything else to the step that last started.
 */
function attribution() {
  const requests = new Map<string, string>();
  return (event: CapturedEvent, current: string | undefined): Event => {
    const key = requestKey(event);
    const known = key === undefined ? undefined : requests.get(key);
    if (known !== undefined) return { ...event, stepId: known, causalConfidence: "network-id" };
    if (current === undefined) return event;
    if (key !== undefined) requests.set(key, current);
    return { ...event, stepId: current, causalConfidence: "temporal-only" };
  };
}

/** Starts the driver's capture into the run's journal; undefined when the driver captures nothing. */
export async function startEvidence(
  driver: ReplayDriver,
  recorder: Recorder,
  secrets: readonly string[],
  runId: string,
): Promise<CaptureHandle | undefined> {
  if (!driver.onCapture) return undefined;
  const attribute = attribution();
  return driver.onCapture({
    runId,
    event: (event) =>
      recorder.evidence(redactEvent(attribute(event, recorder.currentStep()), secrets)),
    blobs: redactingBlobs(recorder.blobs, secrets),
  });
}

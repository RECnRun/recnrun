import type { CapturedEvent, Event } from "@recnrun/protocol";
import type { CaptureHandle, ReplayDriver } from "./driver.ts";
import type { Recorder, ReplayBlobs } from "./record.ts";
import { redact } from "./scope.ts";

/**
 * The payload fields that carry what the page did or said (URLs, header values, bodies, console
 * and error text, storage keys and values, DOM text and values); everything under them is content.
 * Hashes, ids, enums, encodings, and timestamps stay as captured, so the event remains valid.
 */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "url",
  "headers",
  "postData",
  "body",
  "payload",
  "data",
  "text",
  "args",
  "value",
  "oldValue",
  "newValue",
  "key",
  "name",
  "id",
  "testId",
  "description",
  "className",
  "unserializableValue",
  "functionName",
  "message",
  "userInput",
  "errorText",
  "errorMessage",
  "statusText",
  "error",
  "title",
]);

/** A payload with every secret replaced in its content fields; structure and other fields are kept. */
function redactContent(value: unknown, secrets: readonly string[], content: boolean): unknown {
  if (typeof value === "string") return content ? redact(value, secrets) : value;
  if (Array.isArray(value)) return value.map((item) => redactContent(item, secrets, content));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactContent(item, secrets, content || CONTENT_KEYS.has(key)),
    ]),
  );
}

const redactEvent = (event: Event, secrets: readonly string[]): Event =>
  secrets.length === 0
    ? event
    : ({ ...event, payload: redactContent(event.payload, secrets, false) } as Event);

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

import { type Event, NetworkEventSchema } from "@recnrun/protocol";
import { type Output, check } from "@/api/schema";

type NetworkEvent = Output<typeof NetworkEventSchema>;
type Of<T extends NetworkEvent["type"]> = Extract<NetworkEvent, { type: T }>;

/** A body's reference: where its bytes are kept, or why they are not. */
export interface BodyView {
  condition: string;
  mime?: string;
  size?: number;
  sha256?: string;
  reason?: string;
}

/** One HTTP request with what answered it. */
export interface RequestRow {
  requestId: string;
  method: string | undefined;
  url: string;
  status: number | undefined;
  outcome: string;
  durationMs: number | undefined;
  stepId: string | undefined;
  bodies: BodyView[];
}

interface Exchange {
  request?: Of<"request">;
  response?: Of<"response">;
  end?: Of<"finished"> | Of<"failed">;
  bodies: Of<"body">[];
}

const HTTP = new Set(["request", "response", "finished", "failed", "body"]);

function bodyView({ payload }: Of<"body">): BodyView {
  const { condition, blob, reason } = payload;
  if (blob) return { condition, mime: blob.mime, size: blob.size, sha256: blob.sha256 };
  return reason === undefined ? { condition } : { condition, reason };
}

function outcomeOf({ response, end }: Exchange): string {
  if (end?.type === "failed") return `failed: ${end.payload.errorText}`;
  if (!response) return "no response recorded";
  const { status, statusText } = response.payload;
  return statusText ? `${status} ${statusText}` : String(status);
}

/** From the request to its last event, by journal time; unknown without the request. */
function durationOf({ request, response, end }: Exchange): number | undefined {
  const last = end ?? response;
  if (!request || !last) return undefined;
  return Date.parse(last.timestamp) - Date.parse(request.timestamp);
}

function rowOf(requestId: string, exchange: Exchange): RequestRow {
  const { request, response } = exchange;
  return {
    requestId,
    method: request?.payload.method,
    url: request?.payload.url ?? response?.payload.url ?? "",
    status: response?.payload.status,
    outcome: outcomeOf(exchange),
    durationMs: durationOf(exchange),
    stepId: (request ?? response)?.stepId,
    bodies: exchange.bodies.map(bodyView),
  };
}

function add(exchange: Exchange, event: NetworkEvent): void {
  if (event.type === "request") exchange.request = event;
  else if (event.type === "response") exchange.response = event;
  else if (event.type === "finished" || event.type === "failed") exchange.end = event;
  else if (event.type === "body") exchange.bodies.push(event);
}

/** One row per HTTP request id, in the order each was first seen; frames and streams are left out. */
export function pairRequests(events: readonly Event[]): RequestRow[] {
  const exchanges = new Map<string, Exchange>();
  for (const event of events) {
    if (event.category !== "network" || !HTTP.has(event.type)) continue;
    const parsed = check(NetworkEventSchema, event);
    if (!parsed.ok) continue;
    const { requestId } = parsed.value.payload;
    const exchange = exchanges.get(requestId) ?? { bodies: [] };
    exchanges.set(requestId, exchange);
    add(exchange, parsed.value);
  }
  return [...exchanges].map(([requestId, exchange]) => rowOf(requestId, exchange));
}

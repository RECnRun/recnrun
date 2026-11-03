import type { Event } from "@recnrun/protocol";

type Confidence = NonNullable<Event["causalConfidence"]>;

const CAUSES: Record<Confidence, string> = {
  "command-id": "linked by command id",
  initiator: "linked by initiator",
  stack: "linked by stack trace",
  "network-id": "linked by request id",
  "temporal-only": "temporal only",
};

/** How an event is tied to the command before it; `temporal-only` proves nothing more than order. */
export const causeLabel = (confidence: Confidence | undefined): string | undefined =>
  confidence === undefined ? undefined : CAUSES[confidence];

/** One line of the timeline. */
export interface TimelineRow {
  key: string;
  time: string;
  category: string;
  type: string;
  stepId: string | undefined;
  profile: string | undefined;
  summary: string;
  cause: string | undefined;
  gap: boolean;
}

// Payload fields that say most about an event, in the order a person reads them.
const FIELDS = ["status", "method", "url", "observation", "operation", "area", "key", "level"];
const TEXTS = ["text", "errorText", "milestone"];

const scalar = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

function describe(payload: Record<string, unknown>): string {
  const parts = [...FIELDS, ...TEXTS].map((field) => scalar(payload[field]));
  const error = payload["error"];
  if (typeof error === "object" && error !== null && "message" in error)
    parts.push(scalar(error.message));
  return parts.filter((part) => part !== undefined && part !== "").join(" ");
}

type Gap = Extract<Event, { category: "gap" }>;

/** A gap names what the collector lost; it never reads as something the application did. */
function gapSummary({ payload }: Gap): string {
  const surface = payload.surface ? ` on ${payload.surface}` : "";
  const lost =
    payload.lost === undefined
      ? ""
      : `, ${payload.lost} ${payload.lost === 1 ? "event" : "events"} lost`;
  return `collector gap: ${payload.reason}${surface}${lost}`;
}

/** The time of day in UTC to the millisecond, as the journal stamps it. */
export const timeOf = (event: Event) => event.timestamp.slice(11, 23);

export function timelineRow(event: Event): TimelineRow {
  return {
    key: event.id,
    time: timeOf(event),
    category: event.category,
    type: event.type,
    stepId: event.stepId,
    profile: event.profileBinding,
    summary: event.category === "gap" ? gapSummary(event) : describe(event.payload),
    cause: causeLabel(event.causalConfidence),
    gap: event.category === "gap",
  };
}

import type { Event } from "@recnrun/protocol";
import { NOW } from "./fake-api";

let seq = 0;

type Extra = Partial<Omit<Event, "category" | "type" | "payload">>;

/** A journal line of run `run-1`, with the envelope every event carries. */
export function runEvent(
  category: string,
  type: string,
  payload: Record<string, unknown>,
  extra: Extra = {},
): Event {
  seq += 1;
  return {
    schemaVersion: 1,
    id: `cdp:test#${seq}`,
    runId: "run-1",
    seq,
    source: "cdp",
    producer: "cdp:test",
    timestamp: NOW,
    targetId: null,
    frameId: null,
    documentId: null,
    ...extra,
    category,
    type,
    payload,
  } as Event;
}

/** A gap the collector wrote after losing `lost` network events. */
export const lostNetwork = (lost: number, extra: Extra = {}) =>
  runEvent(
    "gap",
    "buffer-exhausted",
    { reason: "buffer-exhausted", surface: "network", lost },
    { component: "collector", ...extra },
  );

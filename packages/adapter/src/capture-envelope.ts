import {
  CapturedEventSchema,
  PROTOCOL_SCHEMA_VERSION,
  type CapturedEvent,
  type Event,
} from "@recnrun/protocol";
import * as v from "valibot";

/** Where an event came from: the producer that numbers it and the page context it belongs to. */
export interface Origin {
  producer: string;
  source: string;
  targetId: string | null;
  frameId: string | null;
  documentId: string | null;
}

/** The part of a captured event its mapping decides; the emitter adds the envelope. */
export interface Draft {
  category: CapturedEvent["category"];
  type: string;
  component: NonNullable<Event["component"]>;
  payload: Record<string, unknown>;
  monotonicTimeMs?: number;
}

/** A mapped CDP event and the context CDP named for it: an execution context or a frame. */
export interface Mapped {
  draft: Draft;
  contextId?: number;
  frameId?: string;
}

export interface Emitter {
  emit(origin: Origin, draft: Draft): void;
  counts(): { events: number; dropped: number };
}

export interface EmitterOptions {
  runId: string;
  onEvent: (event: CapturedEvent) => void;
  now: () => Date;
}

/** Wraps drafts in the §11 envelope and validates them; an invalid one still uses its sequence. */
export function createEmitter({ runId, onEvent, now }: EmitterOptions): Emitter {
  const sequences = new Map<string, number>();
  let events = 0;
  let dropped = 0;
  return {
    emit(origin, { monotonicTimeMs, ...draft }) {
      const seq = (sequences.get(origin.producer) ?? 0) + 1;
      sequences.set(origin.producer, seq);
      const candidate = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        id: `${origin.producer}#${seq}`,
        runId,
        seq,
        timestamp: now().toISOString(),
        ...(monotonicTimeMs !== undefined && { monotonicTimeMs }),
        ...origin,
        ...draft,
      };
      // A skipped sequence number leaves the loss visible in the journal.
      const parsed = v.safeParse(CapturedEventSchema, candidate);
      if (!parsed.success) {
        dropped += 1;
        return;
      }
      events += 1;
      onEvent(parsed.output);
    },
    counts: () => ({ events, dropped }),
  };
}

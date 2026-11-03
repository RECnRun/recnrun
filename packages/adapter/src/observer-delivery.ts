import type { ObserverMessage } from "@recnrun/protocol";

/** What one hook message is to the ledger of its document. */
export type Arrival = "new" | "duplicate" | "invalid";

/** Sequence numbers of a hooked document that neither a message nor a reported gap accounted for. */
export interface Hole {
  sessionId: string;
  producer: string;
  fromSeq: number;
  toSeq: number;
}

export interface DeliveryOptions {
  /** Evaluates `expression` in the context the document lives in; failures are the caller's to ignore. */
  acknowledge(sessionId: string, contextId: number, expression: string): void;
  /** A message the adapter accepted could not be persisted; its sequence range is lost. */
  lost?: (hole: Hole) => void;
  /** Runs `work` soon and returns how to cancel it; defaults to a zero timeout. */
  schedule?: (work: () => void) => () => void;
}

/** One hooked document: everything below `next` is accounted for, and `ahead` holds ranges above it. */
interface Ledger {
  sessionId: string;
  contextId: number;
  documentId: string;
  next: number;
  ahead: [number, number][];
  // The `next` a resend was last asked for, so a hole that cannot be filled is asked about once.
  asked: number;
  // The writes of messages not yet acknowledged; an acknowledgement waits for its batch of them.
  writes: { seq: number; write: Promise<void> }[];
  cancel?: (() => void) | undefined;
  inFlight: boolean;
  closed: boolean;
}

/** The journal producer of a hooked document's messages; their sequence is the hook's own. */
export const hookProducer = (documentId: string): string => `hook:${documentId}`;

const timeout = (work: () => void) => {
  const handle = setTimeout(work, 0);
  return () => clearTimeout(handle);
};

function accounted(ledger: Ledger, seq: number): boolean {
  return seq < ledger.next || ledger.ahead.some(([from, to]) => from <= seq && seq <= to);
}

function account(ledger: Ledger, from: number, to: number): void {
  const ranges = [...ledger.ahead, [from, to] as [number, number]].toSorted(([a], [b]) => a - b);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  while (merged[0] && merged[0][0] <= ledger.next) {
    ledger.next = Math.max(ledger.next, (merged.shift() as [number, number])[1] + 1);
  }
  ledger.ahead = merged;
}

// A reported gap must cover sequence numbers before its own message.
function rangeOf(message: ObserverMessage): [number, number] | undefined | "invalid" {
  if (message.kind !== "gap") return undefined;
  const { fromSeq, toSeq } = message.payload;
  return fromSeq <= toSeq && toSeq < message.seq ? [fromSeq, toSeq] : "invalid";
}

/** The sorted sequence numbers as contiguous ranges. */
function rangesOf(seqs: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const seq of seqs.toSorted((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && seq === last[1] + 1) last[1] = seq;
    else ranges.push([seq, seq]);
  }
  return ranges;
}

/**
 * The adapter's side of the hook's durable delivery: it drops duplicates, acknowledges what
 * arrived once it is written, asks once for a resend of a hole, and on close reports the holes
 * left as sequence ranges.
 */
export class ObserverDelivery {
  duplicates = 0;
  private readonly ledgers = new Map<string, Ledger>();
  private readonly options: DeliveryOptions;

  constructor(options: DeliveryOptions) {
    this.options = options;
  }

  arrive(sessionId: string, contextId: number, message: ObserverMessage): Arrival {
    const range = rangeOf(message);
    if (range === "invalid") return "invalid";
    const ledger = this.ledger(sessionId, contextId, message.documentId);
    if (accounted(ledger, message.seq)) {
      this.duplicates += 1;
      return "duplicate";
    }
    account(ledger, message.seq, message.seq);
    if (range) account(ledger, ...range);
    this.scheduleAck(ledger);
    return "new";
  }

  /** Ties a new message to its persistence: no acknowledgement covers it before `write` settles. */
  wrote(sessionId: string, message: ObserverMessage, write: Promise<void> | undefined): void {
    const ledger = this.ledgers.get(`${sessionId}:${message.documentId}`);
    if (ledger && write) ledger.writes.push({ seq: message.seq, write });
  }

  /** Forgets the documents `matches` selects and answers the holes they leave. */
  close(matches: (sessionId: string, contextId: number) => boolean): Hole[] {
    const holes: Hole[] = [];
    for (const [key, ledger] of this.ledgers) {
      if (!matches(ledger.sessionId, ledger.contextId)) continue;
      ledger.cancel?.();
      ledger.closed = true;
      this.ledgers.delete(key);
      let from = ledger.next;
      for (const [start, end] of ledger.ahead) {
        holes.push(this.hole(ledger, from, start - 1));
        from = end + 1;
      }
    }
    return holes;
  }

  /** The contexts of the hooked documents still open, where the hook can be reached. */
  documents(): { sessionId: string; contextId: number }[] {
    return [...this.ledgers.values()].map(({ sessionId, contextId }) => ({ sessionId, contextId }));
  }

  private ledger(sessionId: string, contextId: number, documentId: string): Ledger {
    const key = `${sessionId}:${documentId}`;
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      ledger = {
        sessionId,
        contextId,
        documentId,
        next: 1,
        ahead: [],
        asked: 0,
        writes: [],
        inFlight: false,
        closed: false,
      };
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }

  private hole(ledger: Ledger, fromSeq: number, toSeq: number): Hole {
    const producer = hookProducer(ledger.documentId);
    return { sessionId: ledger.sessionId, producer, fromSeq, toSeq };
  }

  // One acknowledgement is pending or in flight per document; arrivals meanwhile form the next batch.
  private scheduleAck(ledger: Ledger): void {
    if (ledger.cancel || ledger.inFlight) return;
    ledger.cancel = (this.options.schedule ?? timeout)(() => this.acknowledge(ledger));
  }

  private acknowledge(ledger: Ledger): void {
    ledger.cancel = undefined;
    const upTo = ledger.next - 1;
    const batch = ledger.writes.splice(0);
    if (batch.length === 0) {
      this.ack(ledger, upTo);
      return;
    }
    ledger.inFlight = true;
    void Promise.allSettled(batch.map(({ write }) => write)).then((outcomes) => {
      ledger.inFlight = false;
      const failed = batch.filter((_, index) => outcomes[index]?.status === "rejected");
      for (const [from, to] of rangesOf(failed.map(({ seq }) => seq)))
        this.options.lost?.(this.hole(ledger, from, to));
      if (ledger.closed) return;
      this.ack(ledger, upTo);
      if (ledger.writes.length > 0) this.scheduleAck(ledger);
    });
  }

  private ack(ledger: Ledger, upTo: number): void {
    const resend = ledger.ahead.length > 0 && ledger.asked !== ledger.next;
    if (resend) ledger.asked = ledger.next;
    const args = [JSON.stringify(ledger.documentId), upTo];
    if (resend) args.push(ledger.next);
    const expression = `globalThis.__recnrunHook?.ack?.(${args.join(", ")})`;
    this.options.acknowledge(ledger.sessionId, ledger.contextId, expression);
  }
}

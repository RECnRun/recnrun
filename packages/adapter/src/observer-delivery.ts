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
  cancel?: (() => void) | undefined;
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

/**
 * The adapter's side of the hook's durable delivery: it drops duplicates, acknowledges what
 * arrived so the hook can free its window, asks once for a resend of a hole, and on close
 * reports the holes left as sequence ranges.
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
    ledger.cancel ??= (this.options.schedule ?? timeout)(() => this.acknowledge(ledger));
    return "new";
  }

  /** Forgets the documents `matches` selects and answers the holes they leave. */
  close(matches: (sessionId: string, contextId: number) => boolean): Hole[] {
    const holes: Hole[] = [];
    for (const [key, ledger] of this.ledgers) {
      if (!matches(ledger.sessionId, ledger.contextId)) continue;
      ledger.cancel?.();
      this.ledgers.delete(key);
      let from = ledger.next;
      for (const [start, end] of ledger.ahead) {
        const producer = hookProducer(ledger.documentId);
        holes.push({ sessionId: ledger.sessionId, producer, fromSeq: from, toSeq: start - 1 });
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
      ledger = { sessionId, contextId, documentId, next: 1, ahead: [], asked: 0 };
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }

  private acknowledge(ledger: Ledger): void {
    ledger.cancel = undefined;
    const resend = ledger.ahead.length > 0 && ledger.asked !== ledger.next;
    if (resend) ledger.asked = ledger.next;
    const args = [JSON.stringify(ledger.documentId), ledger.next - 1];
    if (resend) args.push(ledger.next);
    const expression = `globalThis.__recnrunHook?.ack?.(${args.join(", ")})`;
    this.options.acknowledge(ledger.sessionId, ledger.contextId, expression);
  }
}

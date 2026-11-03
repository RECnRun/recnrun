import { CapturedEventSchema, OBSERVER_BINDING, type CapturedEvent } from "@recnrun/protocol";
import * as v from "valibot";
import { expect } from "vite-plus/test";
import { instrumentChannel, type CaptureOptions, type InstrumentOptions } from "../src/index.ts";
import { FakeChannel } from "./fake-channel.ts";
import { now } from "./fake-cdp.ts";

export const DOC = "0123456789abcdef0123456789abcdef";

/** A fake channel whose replies can be scripted per method. */
export class ReplyingChannel extends FakeChannel {
  readonly replies = new Map<string, unknown>();
  /** Methods Chrome does not answer until a test calls the resolver `held` keeps. */
  readonly holding = new Set<string>();
  readonly held: ((reply: unknown) => void)[] = [];

  override send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    const sent = super.send(method, params, sessionId);
    if (this.holding.has(method)) return new Promise<unknown>((resolve) => this.held.push(resolve));
    return this.replies.has(method) ? sent.then(() => this.replies.get(method)) : sent;
  }

  context(sessionId: string, id: number, frameId: string): void {
    this.emit(
      "Runtime.executionContextCreated",
      { context: { id, auxData: { frameId } } },
      sessionId,
    );
  }

  // The hook numbers each document's messages; a message without `seq` takes the next number.
  private readonly hookSeqs = new Map<unknown, number>();

  post(sessionId: string, contextId: number, message: Record<string, unknown>): void {
    const documentId = message["documentId"] ?? DOC;
    const seq = Number(message["seq"] ?? (this.hookSeqs.get(documentId) ?? 0) + 1);
    this.hookSeqs.set(documentId, Math.max(seq, this.hookSeqs.get(documentId) ?? 0));
    const fields = { seq, documentId, ts: 5, targetId: "T1" };
    const payload = JSON.stringify({ ...fields, ...message, seq });
    this.emit(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING, payload, executionContextId: contextId },
      sessionId,
    );
  }
}

/** Instruments a fake browser with capture on; every captured event is checked against its schema. */
export async function capturing(
  options: Partial<CaptureOptions> = {},
  instrument: Pick<InstrumentOptions, "drainTimeoutMs"> = {},
) {
  const channel = new ReplyingChannel();
  const events: CapturedEvent[] = [];
  const handle = await instrumentChannel(channel, {
    ...instrument,
    now,
    capture: {
      runId: "run-1",
      onEvent: (event) => {
        expect(v.is(CapturedEventSchema, event)).toBe(true);
        events.push(event);
      },
      ...options,
    },
  });
  const of = (category: string, type?: string) =>
    events.filter((event) => event.category === category && (!type || event.type === type));
  return { channel, events, handle, of };
}

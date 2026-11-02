import { CapturedEventSchema, OBSERVER_BINDING, type CapturedEvent } from "@recnrun/protocol";
import * as v from "valibot";
import { expect } from "vite-plus/test";
import { instrumentChannel, type CaptureOptions } from "../src/index.ts";
import { FakeChannel } from "./fake-channel.ts";
import { now } from "./fake-cdp.ts";

export const DOC = "0123456789abcdef0123456789abcdef";

/** A fake channel whose replies can be scripted per method. */
export class ReplyingChannel extends FakeChannel {
  readonly replies = new Map<string, unknown>();

  override send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    const sent = super.send(method, params, sessionId);
    return this.replies.has(method) ? sent.then(() => this.replies.get(method)) : sent;
  }

  context(sessionId: string, id: number, frameId: string): void {
    this.emit(
      "Runtime.executionContextCreated",
      { context: { id, auxData: { frameId } } },
      sessionId,
    );
  }

  post(sessionId: string, contextId: number, message: Record<string, unknown>): void {
    const payload = JSON.stringify({ seq: 1, documentId: DOC, ts: 5, targetId: "T1", ...message });
    this.emit(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING, payload, executionContextId: contextId },
      sessionId,
    );
  }
}

/** Instruments a fake browser with capture on; every captured event is checked against its schema. */
export async function capturing(options: Partial<CaptureOptions> = {}) {
  const channel = new ReplyingChannel();
  const events: CapturedEvent[] = [];
  const handle = await instrumentChannel(channel, {
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

import * as v from "valibot";
import { messages, REQUESTS, RequestSchema } from "./protocol.ts";
import type { EventData, EventName, RequestType } from "./protocol.ts";
import type { Transport } from "./transport.ts";

/** Receives a request type and its payload, already validated against the protocol. */
export type RequestHandler = (type: RequestType, payload: unknown) => Promise<unknown>;

export interface BridgeHost {
  stop(): void;
  emit<N extends EventName>(name: N, data: EventData<N>): void;
}

/** Answers page requests from the content script and announces the extension. */
export function createBridgeHost(
  transport: Transport,
  handle: RequestHandler,
  extensionVersion: string,
): BridgeHost {
  const stop = transport.subscribe((message) => {
    const parsed = v.safeParse(RequestSchema, message);
    if (!parsed.success) return;
    const { id, type } = parsed.output;
    const payload = v.safeParse(REQUESTS[type].payload, parsed.output.payload);
    if (!payload.success) {
      transport.send(messages.failure(id, `Invalid ${type} payload.`));
      return;
    }
    handle(type, payload.output).then(
      (result) => transport.send(messages.success(id, result)),
      (error: unknown) =>
        transport.send(
          messages.failure(id, error instanceof Error ? error.message : String(error)),
        ),
    );
  });
  transport.send(messages.announce(extensionVersion));
  return {
    stop,
    emit: (name, data) => transport.send(messages.event(name, data)),
  };
}

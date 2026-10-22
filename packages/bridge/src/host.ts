import * as v from "valibot";
import { messages, RequestSchema } from "./protocol.ts";
import type { RequestType } from "./protocol.ts";
import type { Transport } from "./transport.ts";

export type RequestHandler = (type: RequestType) => Promise<unknown>;

/** Answers page requests from the content script and announces the extension. */
export function createBridgeHost(
  transport: Transport,
  handle: RequestHandler,
  extensionVersion: string,
): () => void {
  const stop = transport.subscribe((message) => {
    const parsed = v.safeParse(RequestSchema, message);
    if (!parsed.success) return;
    const { id, type } = parsed.output;
    handle(type).then(
      (result) => transport.send(messages.success(id, result)),
      (error: unknown) =>
        transport.send(
          messages.failure(id, error instanceof Error ? error.message : String(error)),
        ),
    );
  });
  transport.send(messages.announce(extensionVersion));
  return stop;
}

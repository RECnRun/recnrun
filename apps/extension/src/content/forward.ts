import type { RequestHandler } from "@recnrun/bridge";
import * as v from "valibot";
import { BackgroundReplySchema } from "@/messaging/background-protocol";

/** Forwards page requests to the background, which owns storage access. */
export function createForwardingHandler(
  sendMessage: (message: unknown) => Promise<unknown>,
): RequestHandler {
  return async (type, payload) => {
    const message =
      payload === undefined ? { kind: "request", type } : { kind: "request", type, payload };
    const reply = v.parse(BackgroundReplySchema, await sendMessage(message));
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };
}

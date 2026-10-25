import type { RequestHandler } from "@recnrun/bridge";
import * as v from "valibot";
import { BackgroundReplySchema } from "@/messaging/background-messages";

/** Forwards page requests to the background, which owns storage access. */
export function createForwardingHandler(
  sendMessage: (message: unknown) => Promise<unknown>,
): RequestHandler {
  return async (type) => {
    const reply = v.parse(BackgroundReplySchema, await sendMessage({ type }));
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };
}

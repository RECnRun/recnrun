import type { RequestHandler, RequestPayload } from "@recnrun/bridge";
import { createRequester } from "@/messaging/request";

/** Forwards page requests to the background; the bridge host validated the payload already. */
export function createForwardingHandler(
  sendMessage: (message: unknown) => Promise<unknown>,
): RequestHandler {
  const request = createRequester(sendMessage);
  return (type, payload) => request(type, payload as RequestPayload<typeof type>);
}

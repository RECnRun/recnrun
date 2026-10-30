import { REQUESTS } from "@recnrun/bridge";
import type { RequestPayload, RequestResult, RequestType } from "@recnrun/bridge";
import * as v from "valibot";
import { BackgroundReplySchema } from "@/messaging/background-protocol";

export type Requester = <T extends RequestType>(
  type: T,
  payload?: RequestPayload<T>,
) => Promise<RequestResult<T>>;

/** Asks the background, which alone reads storage, and validates what comes back. */
export function createRequester(sendMessage: (message: unknown) => Promise<unknown>): Requester {
  return async (type, payload) => {
    const message =
      payload === undefined ? { kind: "request", type } : { kind: "request", type, payload };
    const reply = v.parse(BackgroundReplySchema, await sendMessage(message));
    if (!reply.ok) throw new Error(reply.error);
    const result = v.safeParse(REQUESTS[type].result, reply.result);
    if (!result.success) throw new Error(`The background sent an invalid ${type} result.`);
    return result.output as RequestResult<typeof type>;
  };
}

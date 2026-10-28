import * as v from "valibot";
import { BackgroundReplySchema } from "@/messaging/background-messages";
import type { PageRequest, SendRequest } from "@/views/extension-services";

/** Resolves with the background's result; rejects with its error, or when the reply is not one. */
export async function ask(send: SendRequest, request: PageRequest): Promise<unknown> {
  const reply = v.parse(BackgroundReplySchema, await send(request));
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

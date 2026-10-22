import { isRequestType } from "@recnrun/bridge";
import type { RequestType } from "@recnrun/bridge";
import * as v from "valibot";

/** What the content script asks the background, which alone reads extension storage. */
export const BackgroundRequestSchema = v.object({
  type: v.custom<RequestType>(isRequestType),
});

export const BackgroundReplySchema = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.unknown() }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);

export type BackgroundReply = v.InferOutput<typeof BackgroundReplySchema>;

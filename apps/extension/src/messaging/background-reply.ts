import * as v from "valibot";

/** The one reply shape: a bridge request gets a `result`, a session request only `ok`. */
export const BackgroundReplySchema = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.optional(v.unknown()) }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);

export type BackgroundReply = v.InferOutput<typeof BackgroundReplySchema>;

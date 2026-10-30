import * as v from "valibot";

/** The relay asks the background for the response URLs of its frame's origin. */
export const ResponseUrlRequestSchema = v.object({ type: v.literal("response-urls") });

/** Each restored cache entry's request URL, with the URL its response was fetched from. */
export const ResponseUrlPairsSchema = v.array(v.tuple([v.string(), v.string()]));

export type ResponseUrlPairs = v.InferOutput<typeof ResponseUrlPairsSchema>;

/** The page script offers its port on this event; the relay takes it by cancelling the event. */
export const PORT_OFFER_EVENT = "recnrun-response-url-port";
/** The relay announces itself on this event, so a page script that ran first offers again. */
export const RELAY_READY_EVENT = "recnrun-response-url-ready";

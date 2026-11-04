import * as v from "valibot";

/** The bootstrap page asks the background to announce this profile now (POC PLAN.md P2.1). */
export const PocPublishPresenceSchema = v.strictObject({ type: v.literal("POC_PUBLISH_PRESENCE") });

export const pocPublishPresence = (): v.InferOutput<typeof PocPublishPresenceSchema> => ({
  type: "POC_PUBLISH_PRESENCE",
});

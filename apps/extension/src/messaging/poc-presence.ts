import * as v from "valibot";
import { TokenSchema } from "@/p2p/downloads-rendezvous";

/** The bootstrap page asks the background to announce this profile now (POC PLAN.md P2.1). */
export const PocPublishPresenceSchema = v.strictObject({ type: v.literal("POC_PUBLISH_PRESENCE") });

export const pocPublishPresence = (): v.InferOutput<typeof PocPublishPresenceSchema> => ({
  type: "POC_PUBLISH_PRESENCE",
});

/** The bootstrap page asks the background to answer the launcher's open attempt (POC PLAN.md P4.3). */
export const PocLauncherAckSchema = v.strictObject({
  type: v.literal("POC_LAUNCHER_ACK"),
  token: TokenSchema,
});

export const pocLauncherAck = (token: string): v.InferOutput<typeof PocLauncherAckSchema> => ({
  type: "POC_LAUNCHER_ACK",
  token,
});

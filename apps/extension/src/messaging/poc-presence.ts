import * as v from "valibot";
import { TokenSchema } from "@/p2p/downloads-rendezvous";
import { SettingSchema } from "@/p2p/poc-setting";

/** The bootstrap page asks the background to announce this profile now (POC PLAN.md P2.1). */
export const PocPublishPresenceSchema = v.strictObject({ type: v.literal("POC_PUBLISH_PRESENCE") });

export const pocPublishPresence = (): v.InferOutput<typeof PocPublishPresenceSchema> => ({
  type: "POC_PUBLISH_PRESENCE",
});

/** A template base's open attempt names the base; both fields or neither (POC PLAN.md P5.1). */
const AckTemplateSchema = v.strictObject({
  template: v.literal(true),
  setting: SettingSchema,
});
export type AckTemplate = v.InferOutput<typeof AckTemplateSchema>;

/** The bootstrap page asks the background to answer the launcher's open attempt (POC PLAN.md P4.3). */
export const PocLauncherAckSchema = v.union([
  v.strictObject({ type: v.literal("POC_LAUNCHER_ACK"), token: TokenSchema }),
  v.strictObject({
    type: v.literal("POC_LAUNCHER_ACK"),
    token: TokenSchema,
    template: v.literal(true),
    setting: SettingSchema,
  }),
]);

export const pocLauncherAck = (
  token: string,
  template?: AckTemplate,
): v.InferOutput<typeof PocLauncherAckSchema> => ({
  type: "POC_LAUNCHER_ACK",
  token,
  ...template,
});

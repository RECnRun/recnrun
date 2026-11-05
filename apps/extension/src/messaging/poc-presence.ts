import * as v from "valibot";
import { NamespaceSchema, TokenSchema } from "@/p2p/downloads-rendezvous";
import { IdentityKeySchema } from "@/p2p/identity-key";
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

/** What a clone ack adds after the identity (POC PLAN.md P5.3); the three come together. */
const AckCloneSchema = v.strictObject({
  instanceId: TokenSchema,
  operationId: TokenSchema,
  provisioned: v.literal(true),
});
export type AckClone = v.InferOutput<typeof AckCloneSchema>;

/**
 * The bootstrap page of a copied base asks its worker to become the instance the launcher named, a
 * worker of the named master (POC PLAN.md P5.3). Ids are lowercase v4 uuids, as the launcher makes.
 */
export const PocProvisionCloneSchema = v.strictObject({
  type: v.literal("POC_PROVISION_CLONE"),
  token: TokenSchema,
  instanceId: TokenSchema,
  operationId: TokenSchema,
  namespace: NamespaceSchema,
  masterProfileId: TokenSchema,
  masterIdentity: IdentityKeySchema,
});
export type CloneRequest = Omit<v.InferOutput<typeof PocProvisionCloneSchema>, "type">;

export const pocProvisionClone = ({
  token,
  instanceId,
  operationId,
  namespace,
  masterProfileId,
  masterIdentity,
}: CloneRequest): v.InferOutput<typeof PocProvisionCloneSchema> => ({
  type: "POC_PROVISION_CLONE",
  token,
  instanceId,
  operationId,
  namespace,
  masterProfileId,
  masterIdentity,
});

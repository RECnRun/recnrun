import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import { discardCertificate } from "@/p2p/certificate-store";
import { discardIdentityKey } from "@/p2p/identity-key";
import { SettingSchema } from "@/p2p/poc-setting";
import type { TemplateOutcome } from "@/p2p/roles";
import { storedRoles } from "@/storage/hierarchy-repository";
import { pocTransportStore } from "@/storage/poc-transport-repository";

/*
 * What a template base keeps (POC PLAN.md P5.1, P5.3): the role `template`, which gates everything
 * outward from the worker's first start, and the setting the launcher named it by. Items are made
 * on call, so a build that never enters template mode defines none.
 */

/** Peer state a copy must not inherit; the setting, namespace, policy, and identity stay. */
const TRANSIENT = [
  "local:peerPins",
  "local:authorizedPeers",
  "local:answeredOffers",
  "local:folderPairing",
  "session:pendingOffers",
  "session:peerLinks",
  "session:folderActed",
  "session:meshMembers",
  "session:remoteRecordings",
  "session:peerTabs",
  "session:remoteController",
  "session:pocNewcomers",
] as const;

/** Clears what a profile learned of its peers, so no copy of it pairs, links, or answers as it did. */
export async function clearTransientPeerState(): Promise<void> {
  await storage.removeItems([...TRANSIENT]);
  // The template's own presence error and pause would otherwise travel in the base to every clone.
  await pocTransportStore().clearError();
  await pocTransportStore().clearPaused();
}

/** The identity key and the DTLS certificate: a template holds no working pair of them. */
export async function discardWorkingIdentity(): Promise<void> {
  await discardIdentityKey();
  await discardCertificate();
}

const refusal = (outcome: Exclude<TemplateOutcome, { ok: true }>) =>
  outcome.reason === "store-failed"
    ? outcome.error
    : `This profile is the ${outcome.reason === "master" ? "master" : "bound worker"}; it is never made a template.`;

export function pocTemplateStore() {
  const setting = storage.defineItem<unknown>("local:pocSetting");
  const roles = storedRoles();
  return {
    /** The stored role is the one source: an unreadable role is not template mode. */
    templateMode: async () => (await roles.record().catch(() => null))?.role === "template",
    setting: async () => {
      const stored = v.safeParse(SettingSchema, await setting.getValue());
      return stored.success ? stored.output : null;
    },
    /** Holds the role first, so the worker stops before the key, certificate, and peers go. */
    enter: async (name: string) => {
      const parsed = v.parse(SettingSchema, name);
      const held = await roles.holdAsTemplate();
      if (!held.ok) throw new Error(refusal(held));
      await discardWorkingIdentity();
      await clearTransientPeerState();
      await setting.setValue(parsed);
    },
  };
}

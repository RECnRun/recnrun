import * as v from "valibot";
import { browser } from "wxt/browser";
import type { ProfileSources } from "@/diagnostics/profile-report";
import { DEFAULT_NAMESPACE, NamespaceSchema } from "@/p2p/downloads-rendezvous";
import { storedFingerprint } from "@/p2p/certificate-store";
import { storedIdentityKey } from "@/p2p/identity-key";
import { roleStores, storedRoles } from "@/storage/hierarchy-repository";
import { identityRepository, peerPinsRepository } from "@/storage/peer-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { pocTemplateStore } from "@/storage/poc-template-repository";
import { pocTransportStore } from "@/storage/poc-transport-repository";

/** The stored value if it fits `schema`, else `fallback`: a stray value is not this page's error. */
const valid = <T, F>(schema: v.GenericSchema<unknown, T>, stored: unknown, fallback: F) => {
  const parsed = v.safeParse(schema, stored);
  return parsed.success ? parsed.output : fallback;
};

/** The profile section's sources over the extension's own stores; every read here is read-only. */
export function browserProfileSources(): ProfileSources {
  const presence = pocPresenceStore();
  const transport = pocTransportStore();
  const template = pocTemplateStore();
  const roles = storedRoles();
  return {
    version: browser.runtime.getManifest().version,
    granted: async () => {
      const { permissions = [], origins = [] } = await browser.permissions.getAll();
      return { permissions, origins };
    },
    identity: () => identityRepository.read(),
    identityKey: storedIdentityKey,
    fingerprint: storedFingerprint,
    bootId: presence.peekBoot,
    // P5.3 makes the template role the source; the bootstrap page's flag covers a base until then.
    templateMode: async () => (await roles.roleOf()) === "template" || template.templateMode(),
    setting: template.setting,
    role: roles.record,
    boundWorkers: () => roleStores().workers.all(),
    transport: async () => ({
      namespace: valid(NamespaceSchema, await presence.namespace(), DEFAULT_NAMESPACE),
      root: await presence.root.read(),
      policy: valid(v.string(), await presence.policy(), null),
      lastError: await transport.lastError(),
      paused: await transport.paused(),
    }),
    pins: () => peerPinsRepository().all(),
  };
}

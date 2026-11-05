import { browser } from "wxt/browser";
import { createProvisionListener, provisionClone } from "@/background/clone-provisioning";
import type { ProvisionDependencies } from "@/background/clone-provisioning";
import { pocNamespaceOf } from "@/background/downloads-presence";
import type { startPocPresence } from "@/background/downloads-presence";
import type { Sign } from "@/background/greeting";
import { createAckListener, writeAck } from "@/background/launcher-requests";
import type { AckDependencies } from "@/background/launcher-requests";
import { closeOffscreen, offscreenFingerprint } from "@/background/link";
import type { AckTemplate } from "@/messaging/poc-presence";
import type { IdentityStatement } from "@/p2p/identity-key";
import { storedRoles } from "@/storage/hierarchy-repository";
import { identityRepository, readIdentity } from "@/storage/peer-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { clearTransientPeerState, discardWorkingIdentity } from "@/storage/poc-template-repository";

interface PocBootstrapOptions {
  log: (entry: string) => void;
  sign: Sign;
  /** The presence started last, if the role let it start. */
  presence: () => Promise<{ identity: () => IdentityStatement | undefined } | undefined>;
  /** Starts the outward work the role held back. */
  start: () => Promise<void>;
}

/**
 * The bootstrap page's requests a POC worker answers whatever its role (POC PLAN.md P4.3, P5.1,
 * P5.3): the launcher's ack, a template's included, and the provisioning of a copied template.
 */
function startPocBootstrap({ log, sign, presence, start }: PocBootstrapOptions): void {
  const store = pocPresenceStore();
  const own = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  const ackDeps = (identity: AckDependencies["identity"]): AckDependencies => ({
    downloads: browser.downloads,
    profileId: async () => (await readIdentity()).profileId,
    identity,
    namespace: () => pocNamespaceOf(store, log),
    boot: store.boot,
  });
  const latest = async () => (await presence())?.identity();
  const ack = (token: string, template?: AckTemplate) => writeAck(ackDeps(latest), token, template);
  browser.runtime.onMessage.addListener(createAckListener(ack, own));
  const deps: ProvisionDependencies = {
    roles: storedRoles(),
    identity: identityRepository,
    namespace: { read: store.namespace, write: store.setNamespace },
    // The offscreen document keeps the certificate it loaded, so it closes before both go.
    discard: async () => {
      await closeOffscreen();
      await discardWorkingIdentity();
    },
    clearTransient: clearTransientPeerState,
    adoptBoot: store.adoptBoot,
    statement: async (profileId) => sign({ profileId, fingerprint: await offscreenFingerprint() }),
    ack: (token, identity, clone) =>
      writeAck(
        ackDeps(async () => identity),
        token,
        clone,
      ),
    start,
  };
  const provision = createProvisionListener((request) => provisionClone(deps, request), own);
  browser.runtime.onMessage.addListener(provision);
}

type PocPresence = ReturnType<typeof startPocPresence>;

/**
 * Starts the outward work if the role allows, and answers the presence started last. With `poc`,
 * the bootstrap page's ack and clone provisioning answer a template too, and provisioning starts
 * the work later.
 */
export function startedOutward(
  start: () => Promise<PocPresence | undefined>,
  poc: false | Pick<PocBootstrapOptions, "log" | "sign">,
): () => Promise<PocPresence | undefined> {
  let downloads = start();
  const restart = async () => void (await (downloads = start()));
  if (poc) startPocBootstrap({ ...poc, presence: () => downloads, start: restart });
  return () => downloads;
}

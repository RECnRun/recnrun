import { browser } from "wxt/browser";
import { createProvisionListener, provisionClone } from "@/background/clone-provisioning";
import type { ProvisionDependencies } from "@/background/clone-provisioning";
import { pocNamespaceOf } from "@/background/downloads-presence";
import type { startPocPresence } from "@/background/downloads-presence";
import type { Sign } from "@/background/greeting";
import {
  createAckListener,
  createFailureListener,
  writeAck,
  writeFailureAck,
} from "@/background/launcher-requests";
import type { AckDependencies, FailureDependencies } from "@/background/launcher-requests";
import { closeOffscreen, offscreenFingerprint } from "@/background/link";
import { createPrepareListener } from "@/background/poc-prepare";
import type { AckTemplate, BootstrapStep } from "@/messaging/poc-presence";
import { bounded } from "@/p2p/bounded";
import type { IdentityStatement } from "@/p2p/identity-key";
import { storedRoles } from "@/storage/hierarchy-repository";
import { identityRepository, readIdentity } from "@/storage/peer-repository";
import { pocOnboardingStore } from "@/storage/poc-onboarding-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { clearTransientPeerState, discardWorkingIdentity } from "@/storage/poc-template-repository";

// The page waits 10 s per publish and 8 s for the ack; open.sh waits 60 s by default.
const FAILURE_ACK_MS = 8_000;

interface PocBootstrapOptions {
  log: (entry: string) => void;
  sign: Sign;
  /** The presence started last, if the role let it start. */
  presence: () => Promise<{ identity: () => IdentityStatement | undefined } | undefined>;
  /** Starts the outward work the role held back. */
  start: () => Promise<void>;
}

function ackDependencies(
  store: ReturnType<typeof pocPresenceStore>,
  log: (entry: string) => void,
  identity: AckDependencies["identity"],
): AckDependencies {
  return {
    downloads: browser.downloads,
    profileId: async () => (await readIdentity()).profileId,
    identity,
    namespace: () => pocNamespaceOf(store, log),
    boot: store.boot,
  };
}

const boundedFailureAck =
  (deps: FailureDependencies) => (token: string, step: BootstrapStep, error: string) =>
    bounded(writeFailureAck(deps, token, step, error), FAILURE_ACK_MS, "The failure ack");

/**
 * The bootstrap page's requests a POC worker answers whatever its role (POC PLAN.md P4.3, P5.1,
 * P5.3, P6.1): the launcher's ack, a template's included, the provisioning of a copied template, and
 * the master's "Prepare workers" request.
 */
function startPocBootstrap({ log, sign, presence, start }: PocBootstrapOptions): void {
  const store = pocPresenceStore();
  const own = { extensionId: browser.runtime.id, extensionUrl: browser.runtime.getURL("/") };
  const ackDeps = (identity: AckDependencies["identity"]) => ackDependencies(store, log, identity);
  const latest = async () => (await presence())?.identity();
  const ack = (token: string, template?: AckTemplate) => writeAck(ackDeps(latest), token, template);
  browser.runtime.onMessage.addListener(createAckListener(ack, own));
  browser.runtime.onMessage.addListener(
    createFailureListener(boundedFailureAck(ackDeps(latest)), own),
  );
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
  const roles = storedRoles();
  const prepare = createPrepareListener(
    {
      downloads: browser.downloads,
      masterProfileId: async () => {
        const record = await roles.record();
        return record?.role === "master" ? record.profileId : undefined;
      },
      identity: latest,
      namespace: () => pocNamespaceOf(store, log),
      written: pocOnboardingStore().written,
    },
    own,
  );
  browser.runtime.onMessage.addListener(prepare);
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

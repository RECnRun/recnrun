import { browser } from "wxt/browser";
import { askLink, offscreenFingerprint } from "@/background/link";
import type { PeerChannel } from "@/background/peer-channel";
import { signerOf } from "@/p2p/identity-key";
import type { IdentityClaim, IdentityStatement } from "@/p2p/identity-key";
import type { PeerMessage } from "@/p2p/protocol";
import {
  authorizedPeersRepository,
  peerLinksRepository,
  readIdentity,
} from "@/storage/peer-repository";

/** This profile's statement, by its identity key, that a certificate is its own. */
export type Sign = (claim: IdentityClaim) => Promise<IdentityStatement>;

/** Greets a linked peer with this profile's name and a fresh statement for the link's certificate. */
export async function hello(channel: PeerChannel, peer: string, sign: Sign): Promise<void> {
  const { profileId, displayName } = await readIdentity();
  const identity = await sign({ profileId, fingerprint: await offscreenFingerprint() });
  const extensionVersion = browser.runtime.getManifest().version;
  await channel.send(peer, "HELLO", { displayName, extensionVersion, identity });
}

/**
 * Whether a HELLO's statement names the certificate DTLS proved, signed by the identity key the
 * accepted code named: a peer that holds the certificate but not the key fails here.
 */
export async function provenHello(message: Extract<PeerMessage, { type: "HELLO" }>) {
  const authorized = await authorizedPeersRepository.get(message.from);
  if (!authorized) return false;
  const claim = { profileId: message.from, fingerprint: authorized.fingerprint };
  return (await signerOf(message.identity, claim)) === authorized.identity;
}

/** Closes a link whose peer did not prove the accepted certificate and key; the reason stays. */
export async function refuseLink(peer: string): Promise<void> {
  const refused = { state: "failed", verified: false, reason: "certificate" } as const;
  await peerLinksRepository.set(peer, refused);
  await askLink({ type: "close", peer });
}

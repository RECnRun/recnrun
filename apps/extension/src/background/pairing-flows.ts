import { createFolderPairing } from "@/background/folder-pairing";
import type { FolderPairingFlow } from "@/background/folder-pairing";
import { askLink } from "@/background/link";
import { createMeshPairing } from "@/background/mesh-pairing";
import type { MeshPairingFlow } from "@/background/mesh-pairing";
import { createPairing } from "@/background/pairing";
import type { Sign } from "@/background/greeting";
import type { PeerChannel } from "@/background/peer-channel";
import { createPins } from "@/p2p/pins";
import type { PinSource, Pins } from "@/p2p/pins";
import { answeredOffers } from "@/storage/answered-repository";
import {
  authorizedPeersRepository,
  folderActedRepository,
  folderPairingRepository,
  meshMembersRepository,
  peerLinksRepository,
  peerPinsRepository,
  pendingOffersRepository,
  readIdentity,
} from "@/storage/peer-repository";

/** How this profile finds the others: the chosen folder, or the POC builds' Downloads. */
export type Transport = "folder" | "downloads";

/** The pins, and how a first meeting through this build's transport pins a peer. */
export interface Trust {
  pins: Pins;
  source: PinSource;
}

/** Pairing through the RECnRun folder, and through the peers linked already. */
export interface PairingFlows {
  folder: FolderPairingFlow;
  mesh: MeshPairingFlow;
  trust: Trust;
}

/** A link that came up, and the certificate its handshake proved, if any. */
interface LinkedEvent {
  peer: string;
  remoteFingerprint?: string;
}

/**
 * Whether DTLS proved the accepted certificate, which the accepted code's identity key signed, and
 * that key is the pinned one: pinned now on a first meeting, its latest certificate noted after.
 */
export async function trusted({ peer, remoteFingerprint }: LinkedEvent, { pins, source }: Trust) {
  const authorized = await authorizedPeersRepository.get(peer);
  if (!authorized || !remoteFingerprint || remoteFingerprint !== authorized.fingerprint)
    return false;
  // Only a key whose statement names the certificate the handshake proved is pinned, never one a
  // file or code announced alone.
  const proven = { identity: authorized.identity, fingerprint: remoteFingerprint };
  return (await pins.pin(peer, proven, source)).ok;
}

/** Pairing through the folder and through the mesh, which exchange the same offer and answer codes. */
export function createPairingFlows(
  channel: PeerChannel,
  transport: Transport,
  log: (entry: string) => void,
  sign: Sign,
): PairingFlows {
  const trust: Trust = {
    pins: createPins(peerPinsRepository()),
    source: transport === "downloads" ? "local-channel" : "pairing-code",
  };
  const pairing = createPairing({
    askLink,
    identity: readIdentity,
    authorized: authorizedPeersRepository,
    pending: pendingOffersRepository,
    pins: trust.pins,
    sign,
  });
  const folder = createFolderPairing({
    askLink,
    identity: readIdentity,
    pairing,
    pending: pendingOffersRepository,
    link: peerLinksRepository,
    acted: folderActedRepository,
    answered: answeredOffers(),
    state: folderPairingRepository,
    pins: trust.pins,
    log,
  });
  const mesh = createMeshPairing({
    channel,
    identity: readIdentity,
    pairing,
    authorized: authorizedPeersRepository,
    link: peerLinksRepository,
    pending: pendingOffersRepository,
    acted: folderActedRepository,
    members: meshMembersRepository,
    state: folderPairingRepository,
    exclusive: folder.exclusive,
    log,
  });
  return { folder, mesh, trust };
}

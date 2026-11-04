import { createFolderPairing } from "@/background/folder-pairing";
import type { FolderPairingFlow } from "@/background/folder-pairing";
import { askLink } from "@/background/link";
import { createMeshPairing } from "@/background/mesh-pairing";
import type { MeshPairingFlow } from "@/background/mesh-pairing";
import { createPairing } from "@/background/pairing";
import type { PeerChannel } from "@/background/peer-channel";
import { createPins } from "@/p2p/pins";
import type { PinSource, Pins } from "@/p2p/pins";
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

/** Whether DTLS proved the accepted certificate, and the pin, made now on a first meeting, agrees. */
export async function trusted({ peer, remoteFingerprint }: LinkedEvent, { pins, source }: Trust) {
  const authorized = await authorizedPeersRepository.get(peer);
  if (!authorized || !remoteFingerprint || remoteFingerprint !== authorized.fingerprint)
    return false;
  const verdict = await pins.verify(peer, remoteFingerprint);
  if (verdict !== "unpinned") return verdict === "pinned-match";
  // Only the certificate the handshake proved is pinned, never one a file or code announced.
  return (await pins.pin(peer, remoteFingerprint, source)).ok;
}

/** Pairing through the folder and through the mesh, which exchange the same offer and answer codes. */
export function createPairingFlows(
  channel: PeerChannel,
  transport: Transport,
  log: (entry: string) => void,
): PairingFlows {
  const trust: Trust = {
    pins: createPins(peerPinsRepository),
    source: transport === "downloads" ? "local-channel" : "pairing-code",
  };
  const pairing = createPairing({
    askLink,
    identity: readIdentity,
    authorized: authorizedPeersRepository,
    pending: pendingOffersRepository,
    pins: trust.pins,
  });
  const folder = createFolderPairing({
    askLink,
    identity: readIdentity,
    pairing,
    pending: pendingOffersRepository,
    link: peerLinksRepository,
    acted: folderActedRepository,
    state: folderPairingRepository,
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

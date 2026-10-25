import type { PeerStatus } from "@/messaging/peer-results";

/** A status with its pinned peer. */
export type PairedStatus = PeerStatus & { peer: NonNullable<PeerStatus["peer"]> };

/** Why a profile's list offers no Record, Continue, or Stop; undefined while it may. */
export interface PeerBlocks {
  local?: string;
  remote?: string;
}

/** Without a verified link the peer's tabs and session are only what it last reported. */
function lastSeen({ peerSession }: PairedStatus): string {
  return peerSession
    ? `Not connected. Last seen ${peerSession.status}.`
    : "Not connected. These tabs are as last seen.";
}

export function peerBlocks(status: PairedStatus): PeerBlocks {
  return { remote: status.link.verified ? undefined : lastSeen(status) };
}

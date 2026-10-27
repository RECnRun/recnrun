import type { PeerView } from "@/views/peer-view";

/** Why a profile's list offers no Record, Continue, or Stop; undefined while it may. */
export interface PeerBlocks {
  local?: string;
  remote?: string;
}

/** Without a verified link the peer's tabs and session are only what it last reported. */
function lastSeen({ peerSession }: PeerView): string {
  return peerSession
    ? `Not connected. Last seen ${peerSession.status}.`
    : "Not connected. These tabs are as last seen.";
}

/** This profile's list: the peer controls its session, or one runs in the peer. */
function localBlock(status: PeerView): string | undefined {
  if (status.controlledByPeer) return `Controlled from ${status.peer.displayName}`;
  if (status.peerSession?.live) return `Recording in ${status.peer.displayName}`;
  return undefined;
}

/** The peer's list: down, or a session it does not let this profile control runs somewhere. */
function remoteBlock(status: PeerView, localRunning: boolean): string | undefined {
  if (!status.link.verified) return lastSeen(status);
  if (localRunning) return `Recording in ${status.identity.displayName}`;
  if (status.peerSession && !status.peerSession.mine) {
    return `Recording in ${status.peer.displayName}`;
  }
  return undefined;
}

/** One session across the pair: while one runs anywhere, no list offers Record. */
export function peerBlocks(status: PeerView, localRunning: boolean): PeerBlocks {
  return { local: localBlock(status), remote: remoteBlock(status, localRunning) };
}

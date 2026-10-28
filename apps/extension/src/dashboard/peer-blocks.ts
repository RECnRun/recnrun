import type { PeerView } from "@/views/peer-view";

/** Why a profile's list offers no Record, Continue, or Stop; absent while it may. */
export interface PeerBlocks {
  local?: string;
  /** Each peer's list, by its profile id. */
  remotes: Record<string, string>;
}

/** Without a verified link the peer's tabs and session are only what it last reported. */
function lastSeen({ peerSession }: PeerView): string {
  return peerSession
    ? `Not connected. Last seen ${peerSession.status}.`
    : "Not connected. These tabs are as last seen.";
}

/** This profile's list: a peer controls its session, or one runs in a peer. */
function localBlock(views: PeerView[]): string | undefined {
  const controller = views.find(({ controlledByPeer }) => controlledByPeer);
  if (controller) return `Controlled from ${controller.peer.displayName}`;
  const running = views.find(({ peerSession }) => peerSession?.live);
  return running && `Recording in ${running.peer.displayName}`;
}

/**
 * A peer's list: down, or a session runs somewhere that this list does not control: here, in the
 * peer for someone else, or in another peer at all.
 */
function remoteBlock(view: PeerView, views: PeerView[], localRunning: boolean) {
  if (!view.link.verified) return lastSeen(view);
  if (localRunning) return `Recording in ${view.identity.displayName}`;
  if (view.peerSession && !view.peerSession.mine) return `Recording in ${view.peer.displayName}`;
  const elsewhere = views.find((other) => other !== view && other.peerSession?.live);
  return elsewhere && `Recording in ${elsewhere.peer.displayName}`;
}

/** One session across every profile: while one runs anywhere, no list offers Record. */
export function peerBlocks(views: PeerView[], localRunning: boolean): PeerBlocks {
  const remotes = views.flatMap((view) => {
    const block = remoteBlock(view, views, localRunning);
    return block ? [[view.peer.profileId, block] as const] : [];
  });
  const local = localBlock(views);
  return { ...(local && { local }), remotes: Object.fromEntries(remotes) };
}

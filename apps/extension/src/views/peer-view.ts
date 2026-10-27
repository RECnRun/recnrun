import type { PeerEntry, PeerStatus } from "@/messaging/peer-results";

/** One paired profile as a page shows it, with what the status says of this profile. */
export type PeerView = Omit<PeerStatus, "peers" | "controlledBy" | "paused"> &
  PeerEntry & {
    /** Whether this peer started the session that runs here, over a link that holds. */
    controlledByPeer: boolean;
    /** Whether the folder leaves this peer alone until Reconnect. */
    paused: boolean;
  };

/** Each paired profile, in the order the background lists them. */
export function peerViews(status: PeerStatus): PeerView[] {
  const { peers, controlledBy, paused, ...profile } = status;
  return peers.map((entry) => ({
    ...profile,
    ...entry,
    controlledByPeer: entry.peer.profileId === controlledBy,
    paused: paused.includes(entry.peer.profileId),
  }));
}

/** How many peers' links are verified now. */
export const linkedCount = (status: PeerStatus | undefined) =>
  status?.peers.filter(({ link }) => link.verified).length ?? 0;

/** Whether any peer's link is verified now. */
export const anyLinked = (status: PeerStatus | undefined) => linkedCount(status) > 0;

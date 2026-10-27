import type { PeerEntry } from "@/messaging/peer-results";
import type { PeerView } from "@/views/peer-view";

const LABELS = {
  idle: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  failed: "Not reachable",
} as const;

/**
 * The link in a few words. Only a certificate the user never accepted is an error; a link whose
 * certificate is still unchecked is connecting.
 */
export function linkLabel(link: PeerEntry["link"], peerName: string): string {
  if (link.reason === "certificate") return "Error";
  if (link.reason === "closed-by-peer") return `Disconnected by ${peerName}`;
  if (link.reason === "closed-here") return LABELS.disconnected;
  return link.state === "connected" && !link.verified ? LABELS.connecting : LABELS[link.state];
}

/** One peer's link in words: connected names the peer, since only a verified link counts. */
export function linkText({ link, peer }: Pick<PeerView, "link" | "peer">): string {
  if (link.state === "connected" && !link.verified) return `Checking ${peer.displayName}`;
  const label = linkLabel(link, peer.displayName);
  // "Disconnected by <name>" names the peer already.
  return link.reason === "closed-by-peer" ? label : `${label} — ${peer.displayName}`;
}

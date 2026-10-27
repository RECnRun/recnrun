import type { PeerEntry, PeerStatus } from "@/messaging/peer-results";
import { peerViews } from "@/views/peer-view";

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

/** The first peer's link in words: connected names the peer, since only a verified link counts. */
export function linkText(status: PeerStatus | undefined): string {
  if (!status) return "Loading";
  const [view] = peerViews(status);
  if (!view) return "Not paired";
  const { link, peer } = view;
  if (link.state === "connected" && !link.verified) return "Checking the other profile";
  const label = linkLabel(link, peer.displayName);
  // "Disconnected by <name>" names the peer already.
  return link.reason === "closed-by-peer" ? label : `${label} — ${peer.displayName}`;
}

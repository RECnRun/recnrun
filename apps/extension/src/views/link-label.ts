import type { PeerStatus } from "@/messaging/peer-results";

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
export function linkLabel(link: PeerStatus["link"], peerName: string): string {
  if (link.reason === "certificate") return "Error";
  if (link.reason === "closed-by-peer") return `Disconnected by ${peerName}`;
  if (link.reason === "closed-here") return LABELS.disconnected;
  return link.state === "connected" && !link.verified ? LABELS.connecting : LABELS[link.state];
}

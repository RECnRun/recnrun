import { render } from "preact";
import { PairingPage } from "@/pairing/PairingPage";
import type { PeerClient } from "@/views/peer-client";

export function startPairing(root: HTMLElement, client: PeerClient): void {
  const copy = (text: string) => navigator.clipboard.writeText(text);
  render(<PairingPage client={client} copy={copy} />, root);
}

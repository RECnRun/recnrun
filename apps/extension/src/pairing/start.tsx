import { render } from "preact";
import { FolderPage } from "@/pairing/FolderPage";
import { PairingPage } from "@/pairing/PairingPage";
import type { PeerClient } from "@/views/peer-client";

/** The pairing page, or with `#folder` the window the dashboard opens to grant the folder. */
export function startPairing(root: HTMLElement, client: PeerClient, hash = location.hash): void {
  if (hash === "#folder") return render(<FolderPage client={client} />, root);
  const copy = (text: string) => navigator.clipboard.writeText(text);
  render(<PairingPage client={client} copy={copy} />, root);
}

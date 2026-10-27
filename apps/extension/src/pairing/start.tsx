import { render } from "preact";
import { FolderPage } from "@/pairing/FolderPage";
import type { PeerClient } from "@/views/peer-client";

/** The window the dashboard opens to grant the folder: the extension's only page of its own. */
export function startPairing(root: HTMLElement, client: PeerClient): void {
  render(<FolderPage client={client} />, root);
}

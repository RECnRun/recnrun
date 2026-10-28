import { render } from "preact";
import { FolderPage } from "@/folder/FolderPage";
import type { PeerClient } from "@/views/peer-client";

/** The window the dashboard opens to grant the folder: the extension's only page of its own. */
export function startFolder(root: HTMLElement, client: PeerClient): void {
  render(<FolderPage client={client} />, root);
}

import * as v from "valibot";
import { allowFolder, chooseFolder, pickFolder } from "@/p2p/folder-store";
import { FOLDER_HINT } from "@/pairing/FolderSection";
import type { PeerClient } from "@/views/peer-client";
import { useAction, usePeerStatus } from "@/views/use-peer";

interface FolderPageProps {
  client: PeerClient;
  /** Asks for the folder; tests pass one of their own. */
  pick?: () => Promise<FileSystemDirectoryHandle>;
  /** Asks Chrome again for the folder chosen before. */
  allow?: () => Promise<void>;
  close?: () => void;
}

/**
 * The window the dashboard opens, since a framed page cannot show Chrome's folder picker or its
 * prompt: one click grants the folder, pairing starts, and the window closes.
 */
export function FolderPage({
  client,
  pick = () => pickFolder(),
  allow = () => allowFolder(),
  close = () => window.close(),
}: FolderPageProps) {
  const { status } = usePeerStatus(client);
  const action = useAction();
  const again = status?.folder === "prompt";
  const grant = () =>
    action.run(async () => {
      await (again ? allow() : chooseFolder(pick));
      await client.ask({ type: "folder-pair" }, v.unknown());
      close();
    });
  return (
    <main class="pairing">
      <h1>RECnRun folder</h1>
      <p>
        {again
          ? "After a restart, Chrome asks once more before RECnRun may use the folder. Choose Allow on every visit."
          : FOLDER_HINT}
      </p>
      <button type="button" disabled={!status || action.busy} onClick={() => void grant()}>
        {again ? "Allow folder" : "Choose folder"}
      </button>
      {action.error && <p role="alert">{action.error}</p>}
    </main>
  );
}

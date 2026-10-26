import * as v from "valibot";
import type { PeerStatus } from "@/messaging/peer-results";
import { chooseFolder, pickFolder } from "@/p2p/folder-store";
import type { PeerClient } from "@/views/peer-client";
import type { Action } from "@/views/use-peer";

interface FolderSectionProps {
  status: PeerStatus;
  client: PeerClient;
  action: Action;
  /** Asks for the folder; tests pass one of their own. */
  pick?: () => Promise<FileSystemDirectoryHandle>;
}

/** Where pairing through the folder stands, if anywhere. */
function folderText(status: PeerStatus): string | undefined {
  if (status.peer && status.link.verified) return `Paired with ${status.peer.displayName}`;
  if (status.folderPairing) return "Waiting for another profile in the folder…";
  if (status.folder === "prompt") return "Chrome asks again before RECnRun may use the folder.";
  return undefined;
}

/** The folder every profile on this machine chooses; choosing it starts pairing on its own. */
export function FolderSection({
  status,
  client,
  action,
  pick = () => pickFolder(),
}: FolderSectionProps) {
  const pair = () => client.ask({ type: "folder-pair" }, v.unknown()).then(() => {});
  const choose = () =>
    action.run(async () => {
      await chooseFolder(pick);
      await pair();
    });
  const granted = status.folder === "granted";
  const canPair = granted && !status.folderPairing && !status.link.verified;
  const text = folderText(status);
  return (
    <section aria-labelledby="folder-heading">
      <h2 id="folder-heading">RECnRun folder</h2>
      <p>
        In Documents, create a folder named RECnRun, or choose it if another profile already did.
        Profiles that choose the same folder pair on their own.
      </p>
      <p>If iCloud Drive syncs Documents, it uploads what RECnRun keeps in the folder.</p>
      <button type="button" disabled={action.busy} onClick={() => void choose()}>
        {granted ? "Choose another folder" : "Choose folder"}
      </button>
      {canPair && (
        <button type="button" disabled={action.busy} onClick={() => void action.run(pair)}>
          Pair through the folder
        </button>
      )}
      {text && <p>{text}</p>}
    </section>
  );
}

import { useEffect, useState } from "preact/hooks";
import * as v from "valibot";
import type { PeerStatus } from "@/messaging/peer-results";
import { allowFolder, chooseFolder, pickFolder } from "@/p2p/folder-store";
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

/** How the user finds the folder. */
const FOLDER_HINT =
  "In Documents, create a folder named RECnRun, or choose it if another profile already did. " +
  "Profiles that choose the same folder pair on their own.";

const FOLDER_WAIT = "Waiting for another profile in the folder…";

const isPaired = (status: PeerStatus | undefined) =>
  status !== undefined && status.peer !== null && status.link.verified;

/** Whether the window waits for the pair; once paired, it closes itself. */
function useWait(status: PeerStatus | undefined, close: () => void) {
  const [waiting, setWaiting] = useState(false);
  const paired = isPaired(status);
  useEffect(() => {
    // A page the user opened by hand ignores close(), so it shows the folder again.
    if (waiting && paired) {
      setWaiting(false);
      close();
    }
  }, [waiting, paired, close]);
  return { waiting, wait: () => setWaiting(true) };
}

/**
 * The window the dashboard opens for Chrome's folder picker or its prompt: one click grants the
 * folder and pairing starts. Chrome keeps the grant only while a
 * page of the extension is open, so the window waits and closes itself once the profiles pair.
 */
export function FolderPage({
  client,
  pick = () => pickFolder(),
  allow = () => allowFolder(),
  close = () => window.close(),
}: FolderPageProps) {
  const { status } = usePeerStatus(client);
  const action = useAction();
  const { waiting, wait } = useWait(status, close);
  const again = status?.folder === "prompt";
  const grant = () =>
    action.run(async () => {
      if (again) {
        await client.ask({ type: "folder-release" }, v.unknown());
        await allow();
      } else await chooseFolder(pick);
      await client.ask({ type: "folder-pair" }, v.unknown());
      wait();
    });
  return (
    <main class="pairing">
      <h1>RECnRun folder</h1>
      <p>
        {again
          ? "Chrome asks once more before RECnRun may use the folder. Choose Allow on every visit, and it will not ask again."
          : FOLDER_HINT}
      </p>
      {waiting ? (
        <p>
          {FOLDER_WAIT} Keep this window open: Chrome keeps the folder only while it is open. It
          closes by itself once the profiles pair.
        </p>
      ) : (
        <button type="button" disabled={!status || action.busy} onClick={() => void grant()}>
          {again ? "Allow folder" : "Choose folder"}
        </button>
      )}
      {action.error && <p role="alert">{action.error}</p>}
    </main>
  );
}

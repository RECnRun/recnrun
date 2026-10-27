import { useEffect, useState } from "preact/hooks";
import * as v from "valibot";
import type { PeerStatus } from "@/messaging/peer-results";
import { allowFolder, chooseFolder, pickFolder } from "@/p2p/folder-store";
import type { PeerClient } from "@/views/peer-client";
import { anyLinked, linkedCount } from "@/views/peer-view";
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

/** What the window asks for: the folder, or Chrome's grant again, to pair or to let one join. */
function folderHint(status: PeerStatus | undefined): string {
  if (status?.folder !== "prompt") return FOLDER_HINT;
  // A linked profile's links hold the folder's handles, so Chrome offers no "every visit" then.
  if (anyLinked(status)) {
    return "Chrome asks once more before RECnRun may use the folder, so another profile can join.";
  }
  return "Chrome asks once more before RECnRun may use the folder. Choose Allow on every visit, and it will not ask again.";
}

/**
 * Whether the window waits for a profile to pair; once one more did, and none in the folder waits
 * for this one, it closes itself.
 */
function useWait(status: PeerStatus | undefined, close: () => void) {
  // The links that held when the wait began; undefined while not waiting.
  const [since, setSince] = useState<number>();
  const linked = linkedCount(status);
  useEffect(() => {
    // A page the user opened by hand ignores close(), so it shows the folder again.
    if (since !== undefined && linked > since && status?.unpaired.length === 0) {
      setSince(undefined);
      close();
    }
  }, [since, linked, status?.unpaired.length, close]);
  return { waiting: since !== undefined, wait: () => setSince(linked) };
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
    <main class="folder">
      <h1>RECnRun folder</h1>
      <p>{folderHint(status)}</p>
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

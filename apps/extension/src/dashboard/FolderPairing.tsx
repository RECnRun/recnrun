import * as v from "valibot";
import type { PeerStatus } from "@/messaging/peer-results";
import type { PeerServices } from "@/views/remote-peer";
import { useAction } from "@/views/use-peer";

interface FolderPairingProps {
  peers: PeerServices;
  /** Undefined until the background answers. */
  status: PeerStatus | undefined;
}

/**
 * Leads to the folder window, which shows Chrome's folder picker or the prompt Chrome shows once
 * after a restart.
 */
export function FolderBanner({ peers, status }: FolderPairingProps) {
  if (!status || status.folder === "granted") return null;
  const again = status.folder === "prompt";
  return (
    <section class="folder-banner" aria-labelledby="folder-banner-heading">
      <h3 id="folder-banner-heading">
        {again ? "Allow the RECnRun folder" : "Choose the RECnRun folder"}
      </h3>
      <p>
        {again
          ? "After a restart, Chrome asks once more before RECnRun may use the folder."
          : "Your Chrome profiles pair through a folder named RECnRun in Documents."}
      </p>
      <button type="button" onClick={() => void peers.openFolder()}>
        {again ? "Allow folder" : "Choose folder"}
      </button>
    </section>
  );
}

/** What the dashboard shows about the folder: a wait, or the one click pairing needs. */
function folderStep(status: PeerStatus | undefined): { wait?: string; pair?: string } {
  if (status?.folder !== "granted" || status.link.verified) return {};
  const partner = status.peer?.displayName ?? "another profile";
  if (status.folderPairing) return { wait: `Waiting for ${partner} in the RECnRun folder…` };
  return { pair: status.peer ? "Reconnect" : "Pair with another profile" };
}

export function PairControls({ peers, status }: FolderPairingProps) {
  const action = useAction();
  const pair = () =>
    action.run(() => peers.client.ask({ type: "folder-pair" }, v.unknown()).then(() => {}));
  const step = folderStep(status);
  return (
    <div class="pair-controls">
      {step.wait && <p>{step.wait}</p>}
      {step.pair && (
        <button type="button" disabled={action.busy} onClick={() => void pair()}>
          {step.pair}
        </button>
      )}
      <button type="button" onClick={() => void peers.openPairing()}>
        Manage pairing
      </button>
      {action.error && <p role="alert">{action.error}</p>}
    </div>
  );
}

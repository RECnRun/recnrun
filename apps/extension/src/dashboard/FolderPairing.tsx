import * as v from "valibot";
import type { PeerStatus } from "@/messaging/peer-results";
import type { PeerServices } from "@/views/remote-peer";
import { useState } from "preact/hooks";
import { linkText } from "@/views/link-label";
import { useAction } from "@/views/use-peer";
import type { Action } from "@/views/use-peer";

interface FolderPairingProps {
  peers: PeerServices;
  /** Undefined until the background answers. */
  status: PeerStatus | undefined;
}

/**
 * Leads to the folder window, which shows Chrome's folder picker or the prompt Chrome shows once
 * the folder's grant ended.
 */
export function FolderBanner({ peers, status }: FolderPairingProps) {
  if (!status || status.folder === "granted" || status.link.verified) return null;
  const again = status.folder === "prompt";
  return (
    <section class="folder-banner" aria-labelledby="folder-banner-heading">
      <h3 id="folder-banner-heading">
        {again ? "Allow the RECnRun folder" : "Choose the RECnRun folder"}
      </h3>
      <p>
        {again
          ? "Chrome asks once more before RECnRun may use the folder, since its windows closed."
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

/** This profile's name, as the other profile's dashboard shows it. */
function ProfileName({ status, peers, action }: FolderPairingProps & { action: Action }) {
  const [name, setName] = useState(status?.identity.displayName ?? "");
  const save = (event: Event) => {
    event.preventDefault();
    void action.run(() =>
      peers.client.ask({ type: "rename", displayName: name }, v.unknown()).then(() => {}),
    );
  };
  return (
    <form class="profile-name" onSubmit={save}>
      <label for="profile-name">This profile</label>
      <input
        id="profile-name"
        value={name}
        onInput={(event) => setName(event.currentTarget.value)}
      />
      <button type="submit" disabled={action.busy}>
        Save name
      </button>
    </form>
  );
}

/** The link in words, this profile's name, and what the user can do with the link. */
export function PairingSection({ peers, status }: FolderPairingProps) {
  const action = useAction();
  const ask = (type: "folder-pair" | "disconnect" | "forget") => () =>
    void action.run(() => peers.client.ask({ type }, v.unknown()).then(() => {}));
  const step = folderStep(status);
  return (
    <section class="pairing-section" aria-labelledby="pairing-heading">
      <h3 id="pairing-heading">Pairing</h3>
      <p role="status">{linkText(status)}</p>
      {status && <ProfileName peers={peers} status={status} action={action} />}
      <div class="pairing-actions">
        {step.wait && <p>{step.wait}</p>}
        {step.pair && (
          <button type="button" disabled={action.busy} onClick={ask("folder-pair")}>
            {step.pair}
          </button>
        )}
        {status?.link.verified && (
          <button type="button" disabled={action.busy} onClick={ask("disconnect")}>
            Disconnect
          </button>
        )}
        {status?.peer && (
          <button type="button" disabled={action.busy} onClick={ask("forget")}>
            Forget {status.peer.displayName}
          </button>
        )}
        <button type="button" onClick={() => void peers.openPairing()}>
          Manage pairing
        </button>
      </div>
      {action.error && <p role="alert">{action.error}</p>}
    </section>
  );
}

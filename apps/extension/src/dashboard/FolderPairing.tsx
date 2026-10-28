import * as v from "valibot";
import type { PeerRequest } from "@/messaging/peer-messages";
import type { PeerStatus } from "@/messaging/peer-results";
import type { PeerServices } from "@/views/remote-peer";
import { useState } from "preact/hooks";
import { linkText } from "@/views/link-label";
import { anyLinked, peerViews } from "@/views/peer-view";
import type { PeerView } from "@/views/peer-view";
import { useAction } from "@/views/use-peer";
import type { Action } from "@/views/use-peer";

interface FolderPairingProps {
  peers: PeerServices;
  /** Undefined until the background answers. */
  status: PeerStatus | undefined;
}

/** Chrome's folder picker, or its prompt once the grant ended, in the click; then pairing starts. */
async function grantFolder(peers: PeerServices, again: boolean) {
  if (again) {
    // Chrome offers "Allow on every visit" only once no old handle holds the picker's grant.
    await peers.client.ask({ type: "folder-release" }, v.unknown());
    await peers.allowFolder();
  } else await peers.chooseFolder();
  await peers.client.ask({ type: "folder-pair" }, v.unknown());
}

/** A button that grants the folder, and the alert when Chrome or the user refuses. */
function GrantButton({
  peers,
  again,
  label,
}: {
  peers: PeerServices;
  again: boolean;
  label: string;
}) {
  const action = useAction();
  return (
    <>
      <button
        type="button"
        disabled={action.busy}
        onClick={() => void action.run(() => grantFolder(peers, again))}
      >
        {label}
      </button>
      {action.error && <p role="alert">{action.error}</p>}
    </>
  );
}

/** Asks for the folder in the dashboard, which holds Chrome's grant while it is open. */
export function FolderBanner({ peers, status }: FolderPairingProps) {
  if (!status || status.folder === "granted" || anyLinked(status)) return null;
  const again = status.folder === "prompt";
  return (
    <section class="folder-banner" aria-labelledby="folder-banner-heading">
      <h3 id="folder-banner-heading">
        {again ? "Allow the RECnRun folder" : "Choose the RECnRun folder"}
      </h3>
      <p>
        {again
          ? "Chrome asks once more before RECnRun may use the folder. Choose Allow on every visit, and it will not ask again."
          : "Your Chrome profiles pair through a folder named RECnRun in Documents. Create it there, or choose it if another profile already did."}
      </p>
      <GrantButton peers={peers} again={again} label={again ? "Allow folder" : "Choose folder"} />
    </section>
  );
}

interface FolderStep {
  wait?: string;
  pair?: { label: string; request: PeerRequest };
}

/** What the dashboard shows about the folder: a wait, or the one click pairing needs. */
function folderStep(status: PeerStatus | undefined): FolderStep {
  if (status?.folder !== "granted") return {};
  if (status.paused.length > 0) {
    return { pair: { label: "Pair with other profiles", request: { type: "pair-again" } } };
  }
  if (!status.folderPairing) {
    return { pair: { label: "Pair with another profile", request: { type: "folder-pair" } } };
  }
  if (status.peers.length === 0)
    return { wait: "Waiting for another profile in the RECnRun folder…" };
  return {};
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

type Ask = (request: PeerRequest) => () => void;

/** One paired profile: its link in words, and what the user can do with that link. */
function PeerLine({ view, ask, busy }: { view: PeerView; ask: Ask; busy: boolean }) {
  const { peer, link, paused } = view;
  const id = peer.profileId;
  const waits = !link.verified && !paused && view.folder === "granted" && view.folderPairing;
  return (
    <li>
      <p role="status">{linkText(view)}</p>
      {waits && <p>Waiting for {peer.displayName} in the RECnRun folder…</p>}
      <div class="pairing-actions">
        {link.verified && (
          <button type="button" disabled={busy} onClick={ask({ type: "disconnect", peer: id })}>
            Disconnect
          </button>
        )}
        {paused && !link.verified && (
          <button type="button" disabled={busy} onClick={ask({ type: "reconnect", peer: id })}>
            Reconnect
          </button>
        )}
        <button type="button" disabled={busy} onClick={ask({ type: "forget", peer: id })}>
          Forget {peer.displayName}
        </button>
      </div>
    </li>
  );
}

/** Linked, the banner stays hidden, yet a newcomer pairs only while this profile holds the folder. */
function JoinButton({ peers, status }: FolderPairingProps) {
  if (status?.folder === "granted" || !anyLinked(status)) return null;
  return (
    <GrantButton
      peers={peers}
      again={status?.folder === "prompt"}
      label="Let another profile join"
    />
  );
}

/** Each link in words, this profile's name, and what the user can do with the links. */
export function PairingSection({ peers, status }: FolderPairingProps) {
  const action = useAction();
  const ask: Ask = (request) => () =>
    void action.run(() => peers.client.ask(request, v.unknown()).then(() => {}));
  const step = folderStep(status);
  const views = status ? peerViews(status) : [];
  return (
    <section class="pairing-section" aria-labelledby="pairing-heading">
      <h3 id="pairing-heading">Pairing</h3>
      {views.length === 0 && <p role="status">{status ? "Not paired" : "Loading"}</p>}
      {views.length > 0 && (
        <ul class="peer-lines">
          {views.map((view) => (
            <PeerLine key={view.peer.profileId} view={view} ask={ask} busy={action.busy} />
          ))}
        </ul>
      )}
      {status && <ProfileName peers={peers} status={status} action={action} />}
      <div class="pairing-actions">
        {step.wait && <p>{step.wait}</p>}
        {step.pair && (
          <button type="button" disabled={action.busy} onClick={ask(step.pair.request)}>
            {step.pair.label}
          </button>
        )}
        <JoinButton peers={peers} status={status} />
      </div>
      {action.error && <p role="alert">{action.error}</p>}
    </section>
  );
}

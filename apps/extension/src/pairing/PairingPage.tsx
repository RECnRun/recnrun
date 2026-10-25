import * as v from "valibot";
import { useCallback, useEffect, useState } from "preact/hooks";
import { DiagnosticsSchema, PingResultSchema } from "@/messaging/peer-results";
import type { PeerStatus } from "@/messaging/peer-results";
import { signalFileOf } from "@/pairing/folder-signaling";
import type { pickFolder } from "@/pairing/folder-signaling";
import { FolderStep, useFolderPairing } from "@/pairing/FolderStep";
import { ImportStep, OfferStep } from "@/pairing/PairingSteps";
import { useAction, usePeerStatus } from "@/views/use-peer";
import type { Action } from "@/views/use-peer";
import type { PeerClient } from "@/views/peer-client";

interface PairingPageProps {
  client: PeerClient;
  copy: (text: string) => Promise<void>;
  /** Asks for the shared folder; tests pass one of their own. */
  pick?: typeof pickFolder;
}

const STATES = {
  idle: "Not connected",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  failed: "Connection failed",
} as const;

/** The link in words: connected names the peer, since only a verified link counts. */
function linkText(status: PeerStatus | undefined): string {
  if (!status) return "Loading";
  if (!status.peer) return "Not paired";
  const { state, verified } = status.link;
  if (state === "connected" && !verified) return "Checking the other profile";
  return `${STATES[state]} — ${status.peer.displayName}`;
}

function Identity({
  status,
  client,
  action,
}: { status: PeerStatus } & Pick<Props, "client" | "action">) {
  const [name, setName] = useState(status.identity.displayName);
  const save = () =>
    action.run(() => client.ask({ type: "rename", displayName: name }, v.unknown()).then(() => {}));
  return (
    <section aria-labelledby="identity-heading">
      <h2 id="identity-heading">This profile</h2>
      <label for="display-name">Name</label>
      <input
        id="display-name"
        value={name}
        onInput={(event) => setName(event.currentTarget.value)}
      />
      <button type="button" disabled={action.busy} onClick={() => void save()}>
        Save name
      </button>
      <p>Profile id {status.identity.profileId}</p>
    </section>
  );
}

interface Props {
  client: PeerClient;
  action: Action;
}

/** What the user can do with the paired profile: check it answers, and end or revoke the link. */
function LinkActions({ client, action, connected }: Props & { connected: boolean }) {
  const [result, setResult] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<string[]>();
  const ping = () =>
    action.run(async () => {
      setResult(`Pong in ${(await client.ask({ type: "ping" }, PingResultSchema)).latencyMs} ms`);
    });
  const simple = (type: "disconnect" | "forget") => () =>
    void action.run(() => client.ask({ type }, v.unknown()).then(() => setResult(undefined)));
  const diagnose = () =>
    action.run(async () => {
      setDiagnostics((await client.ask({ type: "diagnostics" }, DiagnosticsSchema)).diagnostics);
    });
  return (
    <section aria-labelledby="link-heading">
      <h2 id="link-heading">Link</h2>
      <button type="button" disabled={action.busy || !connected} onClick={() => void ping()}>
        Send ping
      </button>
      <button type="button" disabled={action.busy || !connected} onClick={simple("disconnect")}>
        Disconnect
      </button>
      <button type="button" disabled={action.busy} onClick={simple("forget")}>
        Forget the other profile
      </button>
      <button type="button" disabled={action.busy} onClick={() => void diagnose()}>
        Show diagnostics
      </button>
      {result && <p>{result}</p>}
      {diagnostics && <pre aria-label="Diagnostics">{diagnostics.join("\n")}</pre>}
    </section>
  );
}

/**
 * Pairs this profile with RECnRun in another Chrome profile by hand: no server carries the codes,
 * and both users accept the other profile before any command crosses.
 */
export function PairingPage({ client, copy, pick }: PairingPageProps) {
  const { status } = usePeerStatus(client);
  const action = useAction();
  const connected = status?.link.verified === true;
  const [incoming, setIncoming] = useState<{ code: string }>();
  const onFound = useCallback((code: string) => setIncoming({ code }), []);
  const me = status?.identity.profileId ?? "";
  const folder = useFolderPairing({ client, action, me, onFound, pick });
  const shared = folder.folder;
  const onAccepted = (answer: string | undefined) => {
    if (shared && answer) void action.run(() => shared.publish(signalFileOf(answer)));
  };
  useEffect(() => {
    // A pairing that connected leaves nothing of this profile's behind in the folder.
    if (connected) void shared?.clean(true).catch(() => {});
  }, [connected, shared]);
  return (
    <main class="pairing">
      <h1>Pair another Chrome profile</h1>
      <p role="status">{linkText(status)}</p>
      {status && <Identity status={status} client={client} action={action} />}
      <OfferStep client={client} action={action} copy={copy} />
      {status && <FolderStep pairing={folder} busy={action.busy} />}
      <ImportStep
        client={client}
        action={action}
        copy={copy}
        incoming={incoming}
        onAccepted={onAccepted}
      />
      {status?.peer && <LinkActions client={client} action={action} connected={connected} />}
      {action.error && <p role="alert">{action.error}</p>}
    </main>
  );
}

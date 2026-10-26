import * as v from "valibot";
import { useState } from "preact/hooks";
import { DiagnosticsSchema, PingResultSchema } from "@/messaging/peer-results";
import type { PeerStatus } from "@/messaging/peer-results";
import { FolderSection } from "@/pairing/FolderSection";
import { ImportStep, OfferStep } from "@/pairing/PairingSteps";
import { linkText } from "@/views/link-label";
import { useAction, usePeerStatus } from "@/views/use-peer";
import type { Action } from "@/views/use-peer";
import type { PeerClient } from "@/views/peer-client";

interface PairingPageProps {
  client: PeerClient;
  copy: (text: string) => Promise<void>;
  /** Asks for the RECnRun folder; tests pass one of their own. */
  pick?: () => Promise<FileSystemDirectoryHandle>;
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
 * Pairs this profile with RECnRun in another Chrome profile: through the RECnRun folder, or by
 * hand with codes no server carries, where both users accept the other profile.
 */
export function PairingPage({ client, copy, pick }: PairingPageProps) {
  const { status } = usePeerStatus(client);
  const action = useAction();
  const connected = status?.link.verified === true;
  return (
    <main class="pairing">
      <h1>RECnRun folder and pairing</h1>
      <p role="status">{linkText(status)}</p>
      {status && <FolderSection status={status} client={client} action={action} pick={pick} />}
      {status && <Identity status={status} client={client} action={action} />}
      <details>
        <summary>Pair by hand instead</summary>
        <OfferStep client={client} action={action} copy={copy} />
        <ImportStep client={client} action={action} copy={copy} />
      </details>
      {status?.peer && <LinkActions client={client} action={action} connected={connected} />}
      {action.error && <p role="alert">{action.error}</p>}
    </main>
  );
}

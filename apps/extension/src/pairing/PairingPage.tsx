import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

/** Sends one peer request to the background and resolves with its result. */
export type AskPeer = (request: { type: string; [key: string]: unknown }) => Promise<unknown>;

export interface PeerStatus {
  identity: { profileId: string; displayName: string };
  peer: { profileId: string; displayName: string } | null;
  link: { state: string; verified: boolean };
}

interface Preview {
  kind: "offer" | "answer";
  profileId: string;
  displayName: string;
  sas: string;
  known: boolean;
}

interface PairingProps {
  ask: AskPeer;
  /** Calls back when the identity, the peer, or the link changes; returns the unsubscribe. */
  watch: (onChange: () => void) => () => void;
  /** Folder pairing, when the page offers it. */
  children?: ComponentChildren;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useStatus(ask: AskPeer, watch: PairingProps["watch"]) {
  const [status, setStatus] = useState<PeerStatus>();
  useEffect(() => {
    const refresh = () => void ask({ type: "peer-status" }).then((s) => setStatus(s as PeerStatus));
    refresh();
    return watch(refresh);
  }, [ask, watch]);
  return status;
}

function linkLabel(status: PeerStatus): string {
  if (status.link.verified) return "Connected";
  const labels: Record<string, string> = {
    idle: "Not connected",
    connecting: "Connecting",
    disconnected: "Disconnected",
    failed: "Error",
  };
  return labels[status.link.state] ?? status.link.state;
}

function CodeBox(props: { label: string; code: string }) {
  return (
    <p>
      <label>
        {props.label}
        <textarea readOnly rows={4} value={props.code} />
      </label>
      <button type="button" onClick={() => void navigator.clipboard.writeText(props.code)}>
        Copy {props.label.toLowerCase()}
      </button>
    </p>
  );
}

function Identity({ status, ask }: { status: PeerStatus; ask: AskPeer }) {
  const [name, setName] = useState(status.identity.displayName);
  return (
    <section aria-label="This profile">
      <h2>This profile</h2>
      <p>
        <label>
          Name <input value={name} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <button type="button" onClick={() => void ask({ type: "peer-rename", displayName: name })}>
          Save name
        </button>
      </p>
      <p>
        Profile id <code>{status.identity.profileId}</code>
      </p>
    </section>
  );
}

function PreviewBox(props: { preview: Preview; onAccept: () => void }) {
  const { preview } = props;
  return (
    <div role="group" aria-label="Pairing request">
      <p>
        From <strong>{preview.displayName}</strong> (<code>{preview.profileId}</code>)
        {preview.known ? ", already paired" : ", a new profile"}.
      </p>
      <p>
        Check that both profiles show the code{" "}
        <strong aria-label="Pairing digits">{preview.sas}</strong>.
      </p>
      <button type="button" onClick={props.onAccept}>
        {preview.kind === "offer" ? "Accept and create answer" : "Confirm and connect"}
      </button>
    </div>
  );
}

function ManualPairing({ ask, onError }: { ask: AskPeer; onError: (message?: string) => void }) {
  const [offer, setOffer] = useState("");
  const [pasted, setPasted] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [answer, setAnswer] = useState("");
  const run = (work: () => Promise<void>) => {
    onError(undefined);
    work().catch((error: unknown) => onError(errorText(error)));
  };
  const create = () =>
    run(async () =>
      setOffer(((await ask({ type: "peer-create-offer" })) as { code: string }).code),
    );
  const inspect = () =>
    run(async () => setPreview((await ask({ type: "peer-inspect", code: pasted })) as Preview));
  const accept = () =>
    run(async () => {
      const result = (await ask({ type: "peer-accept", code: pasted })) as { code?: string };
      setPreview(undefined);
      setAnswer(result.code ?? "");
    });
  return (
    <section aria-label="Manual pairing">
      <h2>Manual pairing</h2>
      <button type="button" onClick={create}>
        Create offer
      </button>
      {offer && <CodeBox label="Offer" code={offer} />}
      <p>
        <label>
          Code from the other profile
          <textarea
            rows={4}
            value={pasted}
            onInput={(event) => setPasted(event.currentTarget.value)}
          />
        </label>
        <button type="button" onClick={inspect}>
          Import code
        </button>
      </p>
      {preview && <PreviewBox preview={preview} onAccept={accept} />}
      {answer && <CodeBox label="Answer" code={answer} />}
    </section>
  );
}

function LinkControls({ ask, onError }: { ask: AskPeer; onError: (message?: string) => void }) {
  const [latency, setLatency] = useState<number>();
  const [lines, setLines] = useState<string[]>([]);
  const run = (work: () => Promise<unknown>) => {
    onError(undefined);
    work().catch((error: unknown) => onError(errorText(error)));
  };
  const ping = () =>
    run(async () =>
      setLatency(((await ask({ type: "peer-ping" })) as { latencyMs: number }).latencyMs),
    );
  const diagnose = () =>
    run(async () =>
      setLines(
        ((await ask({ type: "peer-diagnostics" })) as { diagnostics: string[] }).diagnostics,
      ),
    );
  return (
    <section aria-label="Link">
      <h2>Link</h2>
      <button type="button" onClick={ping}>
        Send ping
      </button>
      {latency !== undefined && <p role="status">Pong in {latency} ms</p>}
      <button type="button" onClick={() => run(() => ask({ type: "peer-disconnect" }))}>
        Disconnect
      </button>
      <button type="button" onClick={() => run(() => ask({ type: "peer-forget" }))}>
        Forget the other profile
      </button>
      <button type="button" onClick={diagnose}>
        Show diagnostics
      </button>
      {lines.length > 0 && <pre aria-label="Diagnostics">{lines.join("\n")}</pre>}
    </section>
  );
}

/** The experimental pairing page: identity, manual SDP exchange, and link controls. */
export function PairingPage({ ask, watch, children }: PairingProps) {
  const status = useStatus(ask, watch);
  const [error, setError] = useState<string>();
  if (!status) return <p role="status">Loading…</p>;
  return (
    <main>
      <h1>Pair Chrome profiles</h1>
      <p role="status" aria-label="Link status">
        {linkLabel(status)}
        {status.peer && ` — ${status.peer.displayName}`}
      </p>
      <Identity status={status} ask={ask} />
      <ManualPairing ask={ask} onError={setError} />
      {children}
      <LinkControls ask={ask} onError={setError} />
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

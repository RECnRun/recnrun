import { useEffect, useState } from "preact/hooks";
import { PairingCodeResultSchema, PairingPreviewSchema } from "@/messaging/peer-results";
import type { PairingPreview } from "@/messaging/peer-results";
import type { Action } from "@/views/use-peer";
import type { PeerClient } from "@/views/peer-client";

interface StepProps {
  client: PeerClient;
  action: Action;
  copy: (text: string) => Promise<void>;
}

/** A code to hand over by hand: shown read-only, with a button that copies it. */
function CodeOutput({
  label,
  code,
  copy,
}: {
  label: string;
  code: string;
  copy: StepProps["copy"];
}) {
  const id = `${label.toLowerCase().replaceAll(" ", "-")}-code`;
  const [copied, setCopied] = useState(false);
  return (
    <div class="pairing-code">
      <label for={id}>{label}</label>
      <textarea id={id} readOnly rows={4} value={code} />
      <button type="button" onClick={() => void copy(code).then(() => setCopied(true))}>
        {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      </button>
    </div>
  );
}

/** Step one on the profile that starts: an offer the other profile imports. */
export function OfferStep({ client, action, copy }: StepProps) {
  const [offer, setOffer] = useState<string>();
  const create = () =>
    action.run(async () => {
      // A stale offer left on screen would be copied and answered, and then refused.
      setOffer(undefined);
      setOffer((await client.ask({ type: "create-offer" }, PairingCodeResultSchema)).code);
    });
  return (
    <section aria-labelledby="offer-heading">
      <h2 id="offer-heading">Start pairing</h2>
      <p>Create an offer here and paste it in the other profile. It expires in five minutes.</p>
      <button type="button" disabled={action.busy} onClick={() => void create()}>
        Create offer
      </button>
      {offer && <CodeOutput label="Offer" code={offer} copy={copy} />}
    </section>
  );
}

/** Who made the pasted code, and the digits both profiles must show alike. */
function Preview({ preview }: { preview: PairingPreview }) {
  return (
    <dl class="pairing-preview" aria-label="Pairing check">
      <dt>Profile</dt>
      <dd>{preview.displayName}</dd>
      <dt>Profile id</dt>
      <dd>{preview.profileId}</dd>
      <dt>Pairing digits</dt>
      <dd class="pairing-digits">{preview.digits}</dd>
      {preview.known && <dd>This is the profile already paired.</dd>}
    </dl>
  );
}

interface CheckProps {
  preview: PairingPreview;
  accepted: boolean;
  busy: boolean;
  accept: () => void;
}

/** The pasted code's maker and digits, and the button that accepts it until it is accepted. */
function AcceptCheck({ preview, accepted, busy, accept }: CheckProps) {
  const label = preview.kind === "offer" ? "Accept and create answer" : "Confirm and connect";
  return (
    <>
      <Preview preview={preview} />
      {!accepted && (
        <>
          <p>Accept only if you expect this profile; both profiles show the same digits.</p>
          <button type="button" disabled={busy} onClick={accept}>
            {label}
          </button>
        </>
      )}
    </>
  );
}

interface ImportProps extends StepProps {
  /** A code found in the shared folder, imported as if pasted; a new object is a new code. */
  incoming?: { code: string };
  /** Hears the accepted code's answer, if any, so the folder can carry it back. */
  onAccepted?: (answer: string | undefined) => void;
}

/** Steps two and three: import the other profile's code, check it, and accept it. */
export function ImportStep({ client, action, copy, incoming, onAccepted }: ImportProps) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<PairingPreview>();
  const [answer, setAnswer] = useState<string>();
  const inspect = (pasted = code) =>
    action.run(async () => {
      setAnswer(undefined);
      // The previous code's digits must not stand in for this one's while it is checked.
      setPreview(undefined);
      setPreview(await client.ask({ type: "inspect", code: pasted.trim() }, PairingPreviewSchema));
    });
  useEffect(() => {
    if (!incoming) return;
    setCode(incoming.code);
    void inspect(incoming.code);
    // Only a new code from the folder imports; typing never does.
  }, [incoming]);
  const accept = () =>
    action.run(async () => {
      const result = await client.ask(
        { type: "accept", code: code.trim() },
        PairingCodeResultSchema,
      );
      // The digits stay up, so the other profile can compare them before it connects.
      // Confirming an answer returns no code, and still ends this pairing.
      setAnswer(result.code ?? "");
      setCode("");
      onAccepted?.(result.code);
    });
  return (
    <section aria-labelledby="import-heading">
      <h2 id="import-heading">Import a code</h2>
      <label for="import-code">Code from the other profile</label>
      <textarea
        id="import-code"
        rows={4}
        value={code}
        onInput={(event) => setCode(event.currentTarget.value)}
      />
      <button type="button" disabled={action.busy || !code.trim()} onClick={() => void inspect()}>
        Import code
      </button>
      {preview && (
        <AcceptCheck
          preview={preview}
          accepted={answer !== undefined}
          busy={action.busy}
          accept={() => void accept()}
        />
      )}
      {answer && <CodeOutput label="Answer" code={answer} copy={copy} />}
    </section>
  );
}

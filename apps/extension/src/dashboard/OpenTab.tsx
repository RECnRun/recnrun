import { useState } from "preact/hooks";
import * as v from "valibot";
import { WebUrlSchema } from "@/p2p/protocol";

interface OpenTabProps {
  /** Opens the address in the linked profile; rejects with the reason the profile gave. */
  open: (url: string) => Promise<void>;
  peerName: string;
}

/** An address field and a button that open a tab in a linked profile (POC P7.7). */
export function OpenTab({ open, peerName }: OpenTabProps) {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string }>();
  const submit = (event: Event) => {
    event.preventDefault();
    const parsed = v.safeParse(WebUrlSchema, address.trim());
    if (!parsed.success) {
      setOutcome({ ok: false, text: "Type an http or https address." });
      return;
    }
    setBusy(true);
    open(parsed.output)
      .then(() => setOutcome({ ok: true, text: `Opened in ${peerName}.` }))
      .catch((error: unknown) =>
        setOutcome({ ok: false, text: error instanceof Error ? error.message : "Not opened." }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <form class="open-tab" onSubmit={submit} aria-label={`Open a tab in ${peerName}`}>
      <label>
        Address{" "}
        <input
          type="text"
          data-field="open-tab-address"
          value={address}
          onInput={(event) => setAddress(event.currentTarget.value)}
        />
      </label>{" "}
      <button type="submit" disabled={busy}>
        Open tab
      </button>
      {outcome && (
        <p role={outcome.ok ? "status" : "alert"} data-field="open-tab-result">
          {outcome.text}
        </p>
      )}
    </form>
  );
}

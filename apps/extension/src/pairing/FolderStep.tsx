import { errorMessage } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";
import { PairingCodeResultSchema } from "@/messaging/peer-results";
import { PAIRING_TTL_MS } from "@/p2p/pairing-code";
import { folderSignaling, pickFolder, signalFileOf } from "@/pairing/folder-signaling";
import type { FolderSignaling, SignalFile } from "@/pairing/folder-signaling";
import type { PeerClient } from "@/views/peer-client";
import type { Action } from "@/views/use-peer";

const POLL_MS = 1000;

interface Waiting {
  kind: SignalFile["kind"];
  pairingId?: string;
  until: number;
}

interface FolderOptions {
  client: PeerClient;
  action: Action;
  me: string;
  /** Imports a code found in the folder, which the user then checks and accepts as if pasted. */
  onFound: (code: string) => void;
  pick?: typeof pickFolder;
}

/** Looks for the other profile's file once a second, only while a pairing waits for it. */
function usePolling(folder: FolderSignaling | undefined, onFound: (code: string) => void) {
  const [waiting, setWaiting] = useState<Waiting>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (!folder || !waiting) return;
    const look = async () => {
      if (Date.now() >= waiting.until) throw new Error("Nothing came through the folder in time.");
      const found = await folder.find(waiting.kind, waiting.pairingId);
      if (!found) return;
      setWaiting(undefined);
      onFound(found.code);
    };
    const timer = setInterval(() => {
      look().catch((caught: unknown) => {
        setWaiting(undefined);
        setProblem(errorMessage(caught));
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [folder, waiting, onFound]);
  const wait = (next: Waiting) => {
    setProblem(undefined);
    setWaiting(next);
  };
  return { waiting, problem, wait };
}

/** Pairing through a folder both profiles chose; the manual codes stay as the fallback. */
export function useFolderPairing({
  client,
  action,
  me,
  onFound,
  pick = pickFolder,
}: FolderOptions) {
  const [folder, setFolder] = useState<FolderSignaling>();
  const polling = usePolling(folder, onFound);
  const choose = () =>
    action.run(async () => {
      const chosen = folderSignaling(await pick(), me);
      await chosen.clean(false);
      setFolder(chosen);
    });
  const publishOffer = (chosen: FolderSignaling) =>
    action.run(async () => {
      const { code } = await client.ask({ type: "create-offer" }, PairingCodeResultSchema);
      if (!code) throw new Error("No offer was created.");
      const signal = signalFileOf(code);
      await chosen.publish(signal);
      polling.wait({ kind: "answer", pairingId: signal.pairingId, until: signal.expiresAt });
    });
  const findOffer = () => polling.wait({ kind: "offer", until: Date.now() + PAIRING_TTL_MS });
  return { folder, choose, publishOffer, findOffer, ...polling };
}

type FolderPairing = ReturnType<typeof useFolderPairing>;

const WAITING_TEXT = {
  offer: "Looking for an offer from the other profile…",
  answer: "Waiting for the other profile's answer…",
} as const;

/** The folder's controls: choose it in each profile, then publish an offer or look for one. */
export function FolderStep({ pairing, busy }: { pairing: FolderPairing; busy: boolean }) {
  const { folder, waiting, problem } = pairing;
  return (
    <section aria-labelledby="folder-heading">
      <h2 id="folder-heading">Pair through a shared folder</h2>
      <p>Choose the same folder in both profiles. Each still accepts the other by its digits.</p>
      <button type="button" disabled={busy} onClick={() => void pairing.choose()}>
        {folder ? "Choose another folder" : "Choose shared folder"}
      </button>
      {folder && (
        <>
          <button
            type="button"
            disabled={busy || waiting !== undefined}
            onClick={() => void pairing.publishOffer(folder)}
          >
            Publish offer to the folder
          </button>
          <button
            type="button"
            disabled={busy || waiting !== undefined}
            onClick={pairing.findOffer}
          >
            Find an offer in the folder
          </button>
        </>
      )}
      {waiting && <p>{WAITING_TEXT[waiting.kind]}</p>}
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}

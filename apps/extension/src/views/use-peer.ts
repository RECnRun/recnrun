import { errorMessage } from "@recnrun/domain";
import { useCallback, useEffect, useState } from "preact/hooks";
import { PeerStatusSchema } from "@/messaging/peer-results";
import type { PeerStatus } from "@/messaging/peer-results";
import type { PeerClient } from "@/views/peer-client";

/** This profile's identity, its authorized peer, and the link, read again on every change. */
export function usePeerStatus(client: PeerClient): {
  status: PeerStatus | undefined;
  refresh: () => void;
} {
  const [status, setStatus] = useState<PeerStatus>();
  const refresh = useCallback(() => {
    client
      .ask({ type: "status" }, PeerStatusSchema)
      .then(setStatus)
      .catch(() => setStatus(undefined));
  }, [client]);
  useEffect(() => {
    refresh();
    return client.watch(refresh);
  }, [client, refresh]);
  return { status, refresh };
}

/** Runs one user action at a time and keeps its error for the page to show. */
export function useAction() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy };
}

export type Action = ReturnType<typeof useAction>;

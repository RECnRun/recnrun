import { errorMessage } from "@recnrun/domain";
import { useCallback, useEffect, useState } from "preact/hooks";
import { PeerStatusSchema } from "@/messaging/peer-results";
import type { PeerStatus } from "@/messaging/peer-results";
import type { PeerClient } from "@/views/peer-client";
import type { PeerServices } from "@/views/remote-peer";

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

/** Whether this profile may control `profileId`, asked again on each change; undefined until known. */
export function useMayControl(
  peers: Pick<PeerServices, "mayControl" | "watchControl">,
  profileId: string,
): boolean | undefined {
  const [may, setMay] = useState<boolean>();
  useEffect(() => {
    let latest = 0;
    let live = true;
    const ask = () => {
      const asked = ++latest;
      // A role that cannot be read controls nothing.
      void peers
        .mayControl(profileId)
        .catch(() => false)
        .then((answer) => {
          if (live && asked === latest) setMay(answer);
        });
    };
    ask();
    const stop = peers.watchControl(ask);
    return () => {
      live = false;
      stop();
    };
  }, [peers, profileId]);
  return may;
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

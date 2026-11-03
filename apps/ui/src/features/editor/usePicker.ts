import type { LeaseFence, LocatorList } from "@recnrun/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";

/** The recording session whose page the picker runs on, and the lease that controls it. */
export type PickerSession = { sessionId: string; lease?: LeaseFence | undefined };

/** Shows the picker on the session's page and hands over the pick's locators; no session, no picker. */
export function usePicker(
  session: PickerSession | undefined,
  onPicked: (target: LocatorList) => void,
) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [picking, setPicking] = useState(false);
  const active = useRef(false);
  active.current = picking;
  const sessionId = session?.sessionId;
  const stop = (id: string) => {
    setPicking(false);
    run(async () => {
      await api.call("picker.stop", { sessionId: id });
    });
  };
  useEffect(() => {
    if (!picking || !sessionId) return undefined;
    return api.on("picker.picked", (message) => {
      if (message.sessionId !== sessionId) return;
      onPicked(message.locators);
      stop(sessionId);
    });
    // `onPicked` and `stop` are new closures every render; the subscription follows the picker.
  }, [api, picking, sessionId]);
  // Leaving the screen mid-pick must not leave the picker running in Chrome.
  useEffect(
    () => () => {
      if (active.current && sessionId)
        api.call("picker.stop", { sessionId }).catch(() => undefined);
    },
    [api, sessionId],
  );
  const start = (id: string) =>
    run(async () => {
      await api.call("picker.start", { sessionId: id }, { lease: session?.lease });
      setPicking(true);
    });
  return {
    available: sessionId !== undefined,
    picking,
    start: () => {
      if (sessionId) start(sessionId);
    },
    cancel: () => {
      if (picking && sessionId) stop(sessionId);
    },
    error,
    busy,
  };
}

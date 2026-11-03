import type { Target } from "@recnrun/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";

/** Asks the service to pick an element in Chrome and hands over the target the user picked. */
export function usePicker(onPicked: (target: Target) => void) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [pickerId, setPickerId] = useState<string>();
  const active = useRef<string | undefined>(undefined);
  active.current = pickerId;
  const stop = (id: string) => {
    setPickerId(undefined);
    run(async () => {
      await api.call("picker.stop", { pickerId: id });
    });
  };
  useEffect(() => {
    if (!pickerId) return undefined;
    return api.on("picker.picked", (message) => {
      if (message.pickerId !== pickerId) return;
      onPicked(message.target);
      stop(pickerId);
    });
    // `onPicked` and `stop` are new closures every render; the subscription follows the picker.
  }, [api, pickerId]);
  // Leaving the screen mid-pick must not leave the picker running in Chrome.
  useEffect(
    () => () => {
      if (active.current) api.call("picker.stop", { pickerId: active.current }).catch(() => {});
    },
    [api],
  );
  const start = () =>
    run(async () => {
      setPickerId((await api.call("picker.start", {})).pickerId);
    });
  const cancel = () => {
    if (pickerId) stop(pickerId);
  };
  return { picking: pickerId !== undefined, start, cancel, error, busy };
}

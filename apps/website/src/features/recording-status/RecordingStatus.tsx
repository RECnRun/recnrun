import type { RecordingStatus as Status } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";
import type { ExtensionGateway } from "@/services/extension";
import { errorMessage } from "@/ui/error-message";

/** The recording of this tab's group, kept live through `recordingChanged` events. */
function useRecordingStatus(gateway: ExtensionGateway): Status | undefined {
  const [status, setStatus] = useState<Status | undefined>(undefined);
  useEffect(() => {
    let active = true;
    gateway.status().then(
      (next) => active && setStatus(next),
      () => undefined,
    );
    const unsubscribe = gateway.onRecordingChanged((next) => active && setStatus(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [gateway]);
  return status;
}

export function RecordingStatus({ gateway }: { gateway: ExtensionGateway }) {
  const status = useRecordingStatus(gateway);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const workflow = status?.workflow;
  if (!workflow) return null;

  const run = (action: Promise<unknown>) => {
    setFailure(undefined);
    action.catch((error: unknown) => setFailure(errorMessage(error)));
  };
  return (
    <aside class="recording-status" aria-label="Current recording">
      <p>
        <span class="record-dot" aria-hidden="true" /> Recording <strong>{workflow.title}</strong>{" "}
        in this tab group.
      </p>
      {status.missingOrigins.length > 0 && (
        <p>
          Pages on these origins are not recorded until you allow access:
          {status.missingOrigins.map((origin) => (
            <button
              key={origin}
              type="button"
              class="button"
              onClick={() => run(gateway.grantOrigins([origin]))}
            >
              Allow access to {origin}
            </button>
          ))}
        </p>
      )}
      <button type="button" class="button" onClick={() => run(gateway.stop(workflow.id))}>
        Stop
      </button>
      {failure && <p role="alert">{failure}</p>}
    </aside>
  );
}

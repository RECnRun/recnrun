import type { RecordingStatus, Workflow } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";
import type { Requester } from "@/messaging/request";
import { RecordingPanel } from "@/popup/RecordingPanel";
import { StartForm } from "@/popup/StartForm";

export type Send = Requester;

interface Loaded {
  status: RecordingStatus;
  stopped: Workflow[];
}

async function load(send: Send): Promise<Loaded> {
  const [status, workflows] = await Promise.all([
    send("getRecordingStatus"),
    send("listWorkflows"),
  ]);
  return { status, stopped: workflows.filter((workflow) => workflow.status === "stopped") };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every action reloads the status, since the background decides what changed. */
function usePopup(send: Send) {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const refresh = () =>
    load(send).then(
      (next) => {
        setLoaded(next);
        setFailure(undefined);
      },
      (error: unknown) => setFailure(describe(error)),
    );
  useEffect(() => {
    void refresh();
  }, [send]);
  const act = (work: Promise<unknown>) => {
    work.then(refresh, (error: unknown) => setFailure(describe(error)));
  };
  return { loaded, failure, act };
}

export function Popup({ send, dashboardUrl }: { send: Send; dashboardUrl: string }) {
  const { loaded, failure, act } = usePopup(send);
  const workflow = loaded?.status.workflow;
  return (
    <main class="popup">
      <h1>RECnRun</h1>
      {!loaded && !failure && <p role="status">Loading…</p>}
      {loaded && workflow && (
        <RecordingPanel
          workflow={workflow}
          missingOrigins={loaded.status.missingOrigins}
          onAllow={(origin) => act(send("grantOrigins", { origins: [origin] }))}
          onStop={() => act(send("stopWorkflow", { id: workflow.id }))}
        />
      )}
      {loaded && !workflow && (
        <StartForm
          stopped={loaded.stopped}
          onStart={(draft) => act(send("startWorkflow", draft))}
          onResume={(id) => act(send("resumeWorkflow", { id }))}
        />
      )}
      {failure && <p role="alert">{failure}</p>}
      <p>
        <a href={dashboardUrl} target="_blank" rel="noreferrer">
          Open the dashboard
        </a>
      </p>
    </main>
  );
}

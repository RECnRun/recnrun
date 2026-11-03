import type { RunSummary } from "@recnrun/protocol";
import type { Api } from "@/api/api";
import { useLoad } from "@/api/context";
import { allEvents } from "@/features/diagnostics/filters";
import { Requests } from "@/features/diagnostics/Requests";
import { StorageOperations } from "@/features/diagnostics/StorageOperations";
import { Timeline } from "@/features/diagnostics/Timeline";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Loadable } from "@/ui/States";

type Props = { runId: string; onBack: (flowId: string) => void };

/** The run's summary and the ids of the steps it started, in order. */
async function loadRun(api: Api, runId: string) {
  const [summary, started] = await Promise.all([
    api.call("run.summary", { runId }),
    allEvents(api, { runId, types: ["step.started"] }),
  ]);
  const steps = [...new Set(started.flatMap(({ stepId }) => (stepId ? [stepId] : [])))];
  return { summary, steps };
}

function RunFacts({ summary, onBack }: { summary: RunSummary; onBack: Props["onBack"] }) {
  const tone = summary.status === "passed" ? "success" : "danger";
  return (
    <Card
      title={`Run ${summary.runId}`}
      actions={<Button onClick={() => onBack(summary.flowId)}>Back to run</Button>}
    >
      <p>
        <Badge tone={tone}>{summary.status}</Badge> Flow <code>{summary.flowId}</code>, started{" "}
        <code>{summary.startedAt}</code>
      </p>
    </Card>
  );
}

/** What a run recorded: its timeline, requests, storage, and how it compares with a baseline. */
export function Diagnostics({ runId, onBack }: Props) {
  const { loaded, reload } = useLoad((api) => loadRun(api, runId), runId);
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {({ summary, steps }) => (
        <>
          <RunFacts summary={summary} onBack={onBack} />
          <Card title="Timeline">
            <Timeline runId={runId} steps={steps} />
          </Card>
          <Card title="Requests">
            <Requests runId={runId} />
          </Card>
          <Card title="Storage operations">
            <StorageOperations runId={runId} />
          </Card>
        </>
      )}
    </Loadable>
  );
}

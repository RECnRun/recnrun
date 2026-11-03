import type { RunSummary, StepResult } from "@recnrun/protocol";
import { useEffect, useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";
import type { RunValues } from "@/features/run/inputs";
import { stepResultOf } from "@/features/run/steps";

type Pushed = { runId: string; result: StepResult };

const keyOf = (result: StepResult) =>
  `${result.stepPath?.join("/") ?? result.stepId}#${result.iterationId ?? ""}`;

/** One row per executed step instance, in first-seen order, holding its latest result. */
function latestResults(results: StepResult[]): StepResult[] {
  const rows = new Map<string, StepResult>();
  for (const result of results) rows.set(keyOf(result), result);
  return [...rows.values()];
}

/** Starts a replay and follows its pushed step events until the service pushes its summary. */
export function useRun(flowId: string) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [runId, setRunId] = useState<string>();
  const [pushed, setPushed] = useState<Pushed[]>([]);
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  // Subscribed before the replay starts, since events can arrive before its answer does.
  useEffect(() => {
    const offStep = api.on("run.step", ({ runId: id, event }) => {
      const result = stepResultOf(event);
      if (result) setPushed((list) => [...list, { runId: id, result }]);
    });
    const offDone = api.on("run.finished", ({ summary }) =>
      setSummaries((list) => [...list, summary]),
    );
    return () => {
      offStep();
      offDone();
    };
  }, [api]);
  const summary = summaries.find((entry) => entry.runId === runId);
  const start = ({ inputs, secrets }: RunValues) =>
    run(async () => {
      setRunId(undefined);
      // Secrets go only in their own transient field, and only when there are any.
      const params =
        Object.keys(secrets).length > 0 ? { flowId, inputs, secrets } : { flowId, inputs };
      setRunId((await api.call("flow.replay", params)).runId);
    });
  const own = pushed.filter((message) => message.runId === runId).map(({ result }) => result);
  const running = runId !== undefined && summary === undefined;
  return { runId, steps: latestResults(own), summary, running, error, busy, start };
}

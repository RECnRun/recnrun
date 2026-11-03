import type { RunSummary, StepResult } from "@recnrun/protocol";
import { useEffect, useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";

type Pushed = { runId: string; result: StepResult };

const keyOf = (result: StepResult) =>
  `${result.stepPath?.join("/") ?? result.stepId}#${result.iterationId ?? ""}`;

/** One row per executed step instance, in first-seen order, holding its latest result. */
export function latestResults(results: StepResult[]): StepResult[] {
  const rows = new Map<string, StepResult>();
  for (const result of results) rows.set(keyOf(result), result);
  return [...rows.values()];
}

/** Starts a replay and follows its pushed step results until the service reports it finished. */
export function useRun(flowId: string) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [runId, setRunId] = useState<string>();
  const [pushed, setPushed] = useState<Pushed[]>([]);
  const [finished, setFinished] = useState<string[]>([]);
  const [summary, setSummary] = useState<RunSummary>();
  // Subscribed before the replay starts, since results can arrive before its answer does.
  useEffect(() => {
    const offStep = api.on("run.step", (message) => setPushed((list) => [...list, message]));
    const offDone = api.on("run.finished", ({ runId: id }) => setFinished((list) => [...list, id]));
    return () => {
      offStep();
      offDone();
    };
  }, [api]);
  const done = runId !== undefined && finished.includes(runId);
  useEffect(() => {
    if (!runId || !done) return;
    run(async () => setSummary(await api.call("run.summary", { runId })));
    // `run` is a new closure every render; the summary is read once per finished run.
  }, [api, runId, done]);
  const start = (inputs: Record<string, unknown>) =>
    run(async () => {
      setSummary(undefined);
      setRunId((await api.call("flow.replay", { flowId, inputs })).runId);
    });
  const own = pushed.filter((message) => message.runId === runId).map(({ result }) => result);
  const running = runId !== undefined && !done;
  return { runId, steps: latestResults(own), summary, running, error, busy, start };
}

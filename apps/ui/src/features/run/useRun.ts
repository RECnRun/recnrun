import type { RunSummary, StepResult } from "@recnrun/protocol";
import { useEffect, useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";
import type { ApiError } from "@/api/error";
import type { RunValues } from "@/features/run/inputs";
import { useReconcile } from "@/features/run/reconcile";
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

const storageKey = (flowId: string) => `recnrun.run.${flowId}`;

/** The run this tab last started for the flow; storage may be unavailable, which only loses it. */
function storedRun(flowId: string): string | undefined {
  try {
    return sessionStorage.getItem(storageKey(flowId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeRun(flowId: string, runId: string) {
  try {
    sessionStorage.setItem(storageKey(flowId), runId);
  } catch {
    // Without storage, a remount simply starts from an empty screen.
  }
}

/** Starts a replay and follows its pushed step events until its summary or failure is known. */
export function useRun(flowId: string) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [runId, setRunId] = useState(() => storedRun(flowId));
  const [pushed, setPushed] = useState<Pushed[]>([]);
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [failure, setFailure] = useState<ApiError>();
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
  const settled = summary !== undefined || failure !== undefined;
  useReconcile(runId, settled, {
    summary: (found) => setSummaries((list) => [...list, found]),
    failure: setFailure,
  });
  const start = ({ inputs, secrets }: RunValues) =>
    run(async () => {
      setRunId(undefined);
      setFailure(undefined);
      // Secrets go only in their own transient field, and only when there are any.
      const params =
        Object.keys(secrets).length > 0 ? { flowId, inputs, secrets } : { flowId, inputs };
      const started = (await api.call("flow.replay", params)).runId;
      storeRun(flowId, started);
      setRunId(started);
    });
  const own = pushed.filter((message) => message.runId === runId).map(({ result }) => result);
  const running = runId !== undefined && !settled;
  const shown = error ?? failure;
  return { runId, steps: latestResults(own), summary, running, error: shown, busy, start };
}

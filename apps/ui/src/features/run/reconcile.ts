import type { RunSummary } from "@recnrun/protocol";
import { useEffect, useState } from "preact/hooks";
import type { Api } from "@/api/api";
import { useApi } from "@/api/context";
import { type ApiError, toApiError } from "@/api/error";

const FIRST_MS = 500;
const MAX_MS = 5000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks `run.summary` until the run answers one, backing off to 5 s while it is still going. */
async function pollSummary(api: Api, runId: string, live: () => boolean) {
  for (let delay = FIRST_MS; live(); delay = Math.min(delay * 2, MAX_MS)) {
    try {
      return await api.call("run.summary", { runId });
    } catch (error) {
      // `conflict` is the only answer of a run still going; anything else ends the run.
      if (toApiError(error).code !== "conflict") throw error;
    }
    await wait(delay);
  }
  return undefined;
}

type Settle = { summary: (summary: RunSummary) => void; failure: (error: ApiError) => void };

/**
 * Recovers a run's end from `run.summary` while no push has delivered it: at once, after each
 * event socket reconnect, and by polling, so a missed `run.finished` or a replay that failed
 * before writing a summary never leaves the screen running.
 */
export function useReconcile(runId: string | undefined, settled: boolean, settle: Settle) {
  const api = useApi();
  const [opened, setOpened] = useState(0);
  useEffect(() => api.onOpen(() => setOpened((count) => count + 1)), [api]);
  useEffect(() => {
    if (runId === undefined || settled) return undefined;
    let live = true;
    pollSummary(api, runId, () => live).then(
      (summary) => live && summary && settle.summary(summary),
      (error: unknown) => live && settle.failure(toApiError(error)),
    );
    return () => {
      live = false;
    };
    // `settle` holds state setters, which never change.
  }, [api, runId, settled, opened]);
}

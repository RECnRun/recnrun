import type { NormalizationResult, PauseMode, SessionStatus } from "@recnrun/protocol";
import { useEffect, useState } from "preact/hooks";
import type { Api } from "@/api/api";
import { useAction, useApi } from "@/api/context";
import type { ApiError } from "@/api/error";

const EMPTY: NormalizationResult = { steps: [], excluded: [] };

export type SessionView = {
  status: SessionStatus;
  suggestions: NormalizationResult;
  error: ApiError | undefined;
  busy: boolean;
  togglePause: (mode: PauseMode) => void;
  takeControl: () => void;
  stop: () => void;
};

/** Reads suggestions every `pollMs` and after each captured event, one request at a time. */
function useSuggestions(api: Api, sessionId: string, pollMs: number) {
  const [suggestions, setSuggestions] = useState(EMPTY);
  useEffect(() => {
    let live = true;
    let reading = false;
    let again = false;
    const read = async (): Promise<void> => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      const next = await api.call("session.suggestions", { sessionId }).catch(() => undefined);
      reading = false;
      if (live && next) setSuggestions(next);
      if (live && again) {
        again = false;
        await read();
      }
    };
    void read();
    const timer = setInterval(() => void read(), pollMs);
    const off = api.on("session.event", (message) => {
      if (message.sessionId === sessionId) void read();
    });
    return () => {
      live = false;
      clearInterval(timer);
      off();
    };
  }, [api, sessionId, pollMs]);
  return suggestions;
}

/** The session's status as commands answer it and as the service pushes it. */
function useStatus(api: Api, initial: SessionStatus) {
  const [status, setStatus] = useState(initial);
  const { sessionId } = initial;
  useEffect(
    () =>
      api.on("session.status", (message) => {
        if (message.sessionId === sessionId) setStatus(message.status);
      }),
    [api, sessionId],
  );
  return [status, setStatus] as const;
}

/** A recording session's live state and the commands that change it, each fenced by the lease. */
export function useSession(
  initial: SessionStatus,
  onFinalized: (flowId: string) => void,
  pollMs = 1000,
): SessionView {
  const api = useApi();
  const [status, setStatus] = useStatus(api, initial);
  const suggestions = useSuggestions(api, initial.sessionId, pollMs);
  const { error, busy, run } = useAction();
  const sessionId = status.sessionId;
  const options = { lease: status.lease };

  return {
    status,
    suggestions,
    error,
    busy,
    togglePause: (mode) =>
      run(async () => {
        const command = status.pauses[mode] === "paused" ? "session.resume" : "session.pause";
        setStatus(await api.call(command, { sessionId, mode }, options));
      }),
    takeControl: () =>
      run(async () => {
        setStatus(await api.call("session.handoff", { sessionId, to: "manual" }, options));
      }),
    stop: () =>
      run(async () => {
        setStatus(await api.call("session.stop", { sessionId }, options));
        const { flowId } = await api.call("flow.finalize", { sessionId });
        onFinalized(flowId);
      }),
  };
}

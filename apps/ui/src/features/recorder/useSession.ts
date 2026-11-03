import type { GapPayload, NormalizationResult, PauseMode, SessionStatus } from "@recnrun/protocol";
import { useEffect, useState } from "preact/hooks";
import type { Api } from "@/api/api";
import type { PushMessage } from "@/api/commands";
import { useAction, useApi } from "@/api/context";
import type { ApiError } from "@/api/error";

const EMPTY: NormalizationResult = { steps: [], excluded: [] };

export type SessionView = {
  status: SessionStatus;
  suggestions: NormalizationResult;
  gaps: GapPayload[];
  error: ApiError | undefined;
  busy: boolean;
  togglePause: (mode: PauseMode) => void;
  takeControl: () => void;
  stop: () => void;
};

/** Polls suggestions every `pollMs` and merges what `session.event` pushes in between. */
function useLiveSession(api: Api, initial: SessionStatus, pollMs: number) {
  const [status, setStatus] = useState(initial);
  const [suggestions, setSuggestions] = useState(EMPTY);
  const [gaps, setGaps] = useState<GapPayload[]>([]);
  const { sessionId } = initial;
  useEffect(() => {
    const poll = () =>
      api.call("session.suggestions", { sessionId }).then(setSuggestions, () => undefined);
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    const off = api.on("session.event", (message: PushMessage<"session.event">) => {
      if (message.sessionId !== sessionId) return;
      if (message.status) setStatus(message.status);
      if (message.suggestions) setSuggestions(message.suggestions);
      const gap = message.gap;
      if (gap) setGaps((current) => [...current, gap]);
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [api, sessionId, pollMs]);
  return { status, setStatus, suggestions, gaps };
}

/** A recording session's live state and the commands that change it, each fenced by the lease. */
export function useSession(
  initial: SessionStatus,
  onFinalized: (flowId: string) => void,
  pollMs = 1000,
): SessionView {
  const api = useApi();
  const live = useLiveSession(api, initial, pollMs);
  const { error, busy, run } = useAction();
  const { status, setStatus } = live;
  const sessionId = status.sessionId;
  const options = { lease: status.lease };

  return {
    ...live,
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

import { elapsedSeconds, toggled } from "@recnrun/domain";
import type { RecordingSession } from "@recnrun/domain";
import { useEffect, useRef, useState } from "preact/hooks";
import type { RecordingStore } from "@/ports/recording-store";

export type RecordingStatus = "idle" | RecordingSession["status"];

export interface Recording {
  /** False until the first read, so views do not flash an idle state. */
  loaded: boolean;
  status: RecordingStatus;
  /** The tab the session records, while one runs. */
  tabId?: number;
  seconds: number;
  error?: string;
  toggle: () => void;
  stop: () => void;
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The shared recording in progress, kept current as other views change it. */
export function useRecording(store: RecordingStore): Recording {
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const now = useNow(session?.status === "recording");
  useEffect(() => {
    const refresh = () =>
      store.read().then(
        (current) => {
          setSession(current);
          setLoaded(true);
          setError(undefined);
        },
        (caught: unknown) => setError(errorText(caught)),
      );
    void refresh();
    return store.watch(() => void refresh());
  }, [store]);
  const write = (next: RecordingSession | null) =>
    void store.write(next).catch((caught: unknown) => setError(errorText(caught)));
  return {
    loaded,
    status: session?.status ?? "idle",
    tabId: session?.tabId,
    seconds: session ? elapsedSeconds(session, now) : 0,
    error,
    toggle: () => session && write(toggled(session, Date.now())),
    stop: () => write(null),
  };
}

/** Calls onEnd once a recording in progress goes idle, whichever view stopped it. */
export function useEnded(status: RecordingStatus, onEnd: () => void): void {
  const active = useRef(false);
  useEffect(() => {
    if (status !== "idle") active.current = true;
    else if (active.current) {
      active.current = false;
      onEnd();
    }
  }, [status, onEnd]);
}

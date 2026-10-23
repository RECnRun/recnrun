import type { RecordingSession } from "@recnrun/domain";
import { useEffect, useRef, useState } from "preact/hooks";

export type RecordingStatus = "idle" | RecordingSession["status"];

/** Where the recording in progress lives, so every dashboard view shows the same one. */
export interface RecordingStore {
  read: () => Promise<RecordingSession | null>;
  write: (session: RecordingSession | null) => Promise<void>;
  /** Calls back after any view writes; returns the unsubscribe function. */
  watch: (onChange: () => void) => () => void;
}

export interface Recording {
  status: RecordingStatus;
  seconds: number;
  error?: string;
  start: () => void;
  toggle: () => void;
  stop: () => void;
}

/** Elapsed time from timestamps, since Chrome throttles timers in a hidden opener tab. */
export function elapsedSeconds(session: RecordingSession, now: number): number {
  const running = session.status === "recording" ? now - session.since : 0;
  return Math.max(0, Math.floor((session.banked + running) / 1000));
}

export function toggled(session: RecordingSession, now: number): RecordingSession {
  if (session.status === "recording") {
    return { status: "paused", banked: session.banked + now - session.since, since: now };
  }
  return { ...session, status: "recording", since: now };
}

export function formatElapsed(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
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
  const [error, setError] = useState<string>();
  const now = useNow(session?.status === "recording");
  useEffect(() => {
    const refresh = () =>
      store.read().then(
        (current) => {
          setSession(current);
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
    status: session?.status ?? "idle",
    seconds: session ? elapsedSeconds(session, now) : 0,
    error,
    start: () => write({ status: "recording", banked: 0, since: Date.now() }),
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

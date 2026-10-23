import { useEffect, useState } from "preact/hooks";

export type RecordingStatus = "idle" | "recording" | "paused";

interface Clock {
  status: RecordingStatus;
  /** Milliseconds recorded before the current run. */
  banked: number;
  /** When the current run started; meaningful while recording. */
  since: number;
}

export interface Recording {
  status: RecordingStatus;
  seconds: number;
  start: () => void;
  toggle: () => void;
  stop: () => void;
}

const IDLE: Clock = { status: "idle", banked: 0, since: 0 };

/** Elapsed time from timestamps, since Chrome throttles timers in a hidden opener tab. */
export function elapsedSeconds(clock: Clock, now: number): number {
  const running = clock.status === "recording" ? now - clock.since : 0;
  return Math.floor((clock.banked + running) / 1000);
}

export function toggled(clock: Clock, now: number): Clock {
  if (clock.status === "recording") {
    return { status: "paused", banked: clock.banked + now - clock.since, since: now };
  }
  if (clock.status === "paused") return { ...clock, status: "recording", since: now };
  return clock;
}

export function formatElapsed(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/** A stand-in for a recording session; the real one will live in the extension. */
export function useRecording(): Recording {
  const [clock, setClock] = useState<Clock>(IDLE);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (clock.status !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [clock.status]);
  return {
    status: clock.status,
    seconds: elapsedSeconds(clock, now),
    start: () => {
      const started = Date.now();
      setNow(started);
      setClock({ status: "recording", banked: 0, since: started });
    },
    toggle: () => setClock((current) => toggled(current, Date.now())),
    stop: () => setClock(IDLE),
  };
}

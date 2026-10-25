import * as v from "valibot";

const MillisecondsSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** The one recording in progress, shared by every extension view; absent when nothing records. */
export const RecordingSessionSchema = v.object({
  /** The browser tab it records. */
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  status: v.picklist(["recording", "paused"]),
  /** Milliseconds recorded before the current run. */
  banked: MillisecondsSchema,
  /** When the current run started or paused, as epoch milliseconds. */
  since: MillisecondsSchema,
});

export type RecordingSession = v.InferOutput<typeof RecordingSessionSchema>;

/** Elapsed time from timestamps, since Chrome throttles timers in a hidden opener tab. */
export function elapsedSeconds(session: RecordingSession, now: number): number {
  const running = session.status === "recording" ? now - session.since : 0;
  return Math.max(0, Math.floor((session.banked + running) / 1000));
}

/** The session paused if it records, banking the run so far, or recording again if it is paused. */
export function toggled(session: RecordingSession, now: number): RecordingSession {
  if (session.status === "recording") {
    return {
      ...session,
      status: "paused",
      banked: session.banked + now - session.since,
      since: now,
    };
  }
  return { ...session, status: "recording", since: now };
}

export function formatElapsed(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

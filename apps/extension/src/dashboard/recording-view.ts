import type { Recording } from "@recnrun/domain";

export interface RecordingView {
  id: string;
  name: string;
  startUrl: string;
  /** The site the recording starts on, as an origin. */
  workspace: string;
  recordedAt: string;
  duration: string;
  events: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Formats in UTC so a recording reads the same on every machine. */
function formatTimestamp(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${seconds} s`;
}

/** Turns recordings into the labels the dashboard shows, newest first. */
export function toRecordingViews(recordings: readonly Recording[]): RecordingView[] {
  return [...recordings]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((recording) => ({
      id: recording.id,
      name: recording.name,
      startUrl: recording.startUrl,
      workspace: new URL(recording.startUrl).origin,
      recordedAt: formatTimestamp(recording.createdAt),
      duration: formatDuration(recording.durationMs),
      events: plural(recording.eventCount, "event"),
    }));
}

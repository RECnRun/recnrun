import type { Snapshot } from "@recnrun/domain";

const RECORDING_ROUTE = /^\/recordings\/([^/?#]+)/;

export const recordingPath = (id: string) => `/recordings/${encodeURIComponent(id)}`;

/** The recording a route points at, if any. */
export function selectedRecordingId(path: string): string | undefined {
  const encoded = RECORDING_ROUTE.exec(path)?.[1];
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** The tab title for a route: the open recording's name, or the product. */
export function titleFor(snapshot: Snapshot | undefined, path: string): string {
  const id = selectedRecordingId(path);
  const recording = snapshot?.recordings.find((each) => each.id === id);
  if (recording) return `${recording.name} · RECnRun`;
  return "RECnRun";
}

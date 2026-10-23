import type { Snapshot } from "@recnrun/domain";

const RECORDING_ROUTE = /^\/recordings\/([^/?#]+)/;

export const recordingPath = (id: string) => `/recordings/${encodeURIComponent(id)}`;

/** The recording a site path points at, if any. */
export function selectedRecordingId(path: string): string | undefined {
  const id = RECORDING_ROUTE.exec(path)?.[1];
  return id === undefined ? undefined : decodeURIComponent(id);
}

/** The tab title for a route: the selected recording's name, or the product name. */
export function titleFor(snapshot: Snapshot | undefined, path: string): string {
  const id = selectedRecordingId(path);
  const recording = snapshot?.recordings.find((each) => each.id === id);
  return recording ? `${recording.name} · RECnRun` : "RECnRun";
}

/** The site path the dashboard starts on, passed by the content script as `?route=`. */
export function initialRoute(search: string): string {
  const route = new URLSearchParams(search).get("route");
  return route?.startsWith("/") ? route : "/";
}

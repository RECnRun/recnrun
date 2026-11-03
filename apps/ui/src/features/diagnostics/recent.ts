import type { RunSummary } from "@recnrun/protocol";

/** A run this tab opened in Diagnostics, offered as a baseline to compare with. */
export type RecentRun = Pick<RunSummary, "runId" | "flowId" | "status" | "startedAt">;

const KEY = "recnrun.diagnostics.runs";
const LIMIT = 20;

const isRecent = (value: unknown): value is RecentRun =>
  typeof value === "object" &&
  value !== null &&
  ["runId", "flowId", "status", "startedAt"].every(
    (key) => typeof (value as Record<string, unknown>)[key] === "string",
  );

/** The runs this tab opened, newest first; unreadable storage reads as none. */
export function recentRuns(): RecentRun[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter(isRecent) : [];
  } catch {
    return [];
  }
}

/** Puts `run` first; there is no command that lists a flow's runs, so the tab keeps its own. */
export function rememberRun({ runId, flowId, status, startedAt }: RecentRun): void {
  const runs = [
    { runId, flowId, status, startedAt },
    ...recentRuns().filter((r) => r.runId !== runId),
  ];
  try {
    sessionStorage.setItem(KEY, JSON.stringify(runs.slice(0, LIMIT)));
  } catch {
    // Without storage the baseline is typed by its id.
  }
}

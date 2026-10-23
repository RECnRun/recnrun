import * as v from "valibot";
import type { RecordingView } from "@/dashboard/recording-view";
import { WorkspaceSchema } from "@/messaging/dashboard-protocol";

export const workspaceName = (workspace: string) => new URL(workspace).host;

/** The workspace a split dashboard shows, from `?workspace=`, when it is a web origin. */
export function workspaceParam(search: string): string | undefined {
  const value = new URLSearchParams(search).get("workspace");
  return v.is(WorkspaceSchema, value) ? value : undefined;
}

export interface WorkspaceGroup {
  workspace: string;
  recordings: RecordingView[];
}

/** Groups views by workspace, keeping their order, so the newest recording's site comes first. */
export function groupByWorkspace(views: readonly RecordingView[]): WorkspaceGroup[] {
  const groups = new Map<string, RecordingView[]>();
  for (const view of views) {
    groups.set(view.workspace, [...(groups.get(view.workspace) ?? []), view]);
  }
  return [...groups].map(([workspace, recordings]) => ({ workspace, recordings }));
}

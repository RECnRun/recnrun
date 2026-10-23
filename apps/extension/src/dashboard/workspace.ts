import type { RecordingView } from "@/dashboard/recording-view";

export const workspaceName = (workspace: string) => new URL(workspace).host;

/** The workspace a split dashboard shows, from `?workspace=`, when it is a web origin. */
export function workspaceParam(search: string): string | undefined {
  const value = new URLSearchParams(search).get("workspace");
  if (value === null || !URL.canParse(value)) return undefined;
  const { protocol, origin } = new URL(value);
  const web = protocol === "http:" || protocol === "https:";
  return web && origin === value ? value : undefined;
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

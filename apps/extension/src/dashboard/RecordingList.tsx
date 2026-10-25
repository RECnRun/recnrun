import type { Snapshot } from "@recnrun/domain";
import type { ComponentChildren } from "preact";
import { RecordingCard } from "@/dashboard/RecordingCard";
import { toRecordingViews } from "@/dashboard/recording-view";
import type { RecordingView } from "@/dashboard/recording-view";
import { recordingPath } from "@/dashboard/route";
import { RouteLink } from "@/dashboard/RouteLink";
import type { Navigation } from "@/dashboard/RouteLink";
import { groupByWorkspace, workspaceName } from "@/dashboard/workspace";

export function EmptyState(props: { title: string; children: ComponentChildren }) {
  return (
    <div class="empty-state" role="status">
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}

export function WorkspaceSection(props: { workspace: string; children: ComponentChildren }) {
  const id = `workspace-${workspaceName(props.workspace)}`;
  return (
    <section class="workspace" aria-labelledby={id}>
      <h2 id={id}>{workspaceName(props.workspace)}</h2>
      {props.children}
    </section>
  );
}

function RecordingCards({ views, nav }: { views: RecordingView[]; nav: Navigation }) {
  return (
    <div class="recordings">
      {views.map((recording) => (
        <RecordingCard
          key={recording.id}
          recording={recording}
          title={
            <RouteLink path={recordingPath(recording.id)} nav={nav}>
              {recording.name}
            </RouteLink>
          }
        />
      ))}
    </div>
  );
}

/** Every recording, grouped by the site it starts on, each linked to its own route. */
export function RecordingList({ snapshot, nav }: { snapshot: Snapshot; nav: Navigation }) {
  if (snapshot.recordings.length === 0) {
    return (
      <EmptyState title="No recordings yet">
        <p>Open the page you want to capture and start a recording from the extension.</p>
      </EmptyState>
    );
  }
  return groupByWorkspace(toRecordingViews(snapshot.recordings)).map(
    ({ workspace, recordings }) => (
      <WorkspaceSection key={workspace} workspace={workspace}>
        <RecordingCards views={recordings} nav={nav} />
      </WorkspaceSection>
    ),
  );
}

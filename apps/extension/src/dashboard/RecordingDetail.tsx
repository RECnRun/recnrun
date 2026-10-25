import type { Snapshot } from "@recnrun/domain";
import { RecordingCard } from "@/dashboard/RecordingCard";
import { toRecordingViews } from "@/dashboard/recording-view";
import { EmptyState, WorkspaceSection } from "@/dashboard/RecordingList";
import { RouteLink } from "@/dashboard/RouteLink";
import type { Navigation } from "@/dashboard/RouteLink";

/** One recording by its id, with the way back to the list; says so when the id matches none. */
export function RecordingDetail(props: { snapshot: Snapshot; id: string; nav: Navigation }) {
  const recording = toRecordingViews(props.snapshot.recordings).find(({ id }) => id === props.id);
  return (
    <>
      <p>
        <RouteLink path="/" nav={props.nav}>
          All recordings
        </RouteLink>
      </p>
      {recording ? (
        <WorkspaceSection workspace={recording.workspace}>
          <RecordingCard recording={recording} title={recording.name} />
        </WorkspaceSection>
      ) : (
        <EmptyState title="Recording not found">
          <p>This extension has no recording with that link. It may have been deleted.</p>
        </EmptyState>
      )}
    </>
  );
}

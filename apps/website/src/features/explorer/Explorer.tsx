import type { Snapshot } from "@recnrun/domain";
import { EmptyState } from "@/ui/EmptyState";
import { toRecordingViews } from "@/features/explorer/recording-view";
import { RecordingCard } from "@/features/explorer/RecordingCard";

export function Explorer({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.recordings.length === 0) {
    return (
      <EmptyState
        title="No recordings yet"
        message="Open the page you want to capture and start a recording from the extension."
      />
    );
  }
  return (
    <div class="recordings">
      {toRecordingViews(snapshot.recordings).map((recording) => (
        <RecordingCard key={recording.id} recording={recording} />
      ))}
    </div>
  );
}

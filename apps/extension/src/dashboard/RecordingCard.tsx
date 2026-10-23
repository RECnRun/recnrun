import type { ComponentChildren } from "preact";
import type { RecordingView } from "@/dashboard/recording-view";

export function RecordingCard({
  recording,
  title,
}: {
  recording: RecordingView;
  title: ComponentChildren;
}) {
  return (
    <article class="recording" aria-labelledby={`recording-${recording.id}`}>
      <h2 id={`recording-${recording.id}`}>{title}</h2>
      <p class="start-url">{recording.startUrl}</p>
      <dl>
        <dt>Recorded</dt>
        <dd>{recording.recordedAt}</dd>
        <dt>Duration</dt>
        <dd>{recording.duration}</dd>
        <dt>Events</dt>
        <dd>{recording.events}</dd>
      </dl>
    </article>
  );
}

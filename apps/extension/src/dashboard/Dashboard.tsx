import type { Recording, Snapshot } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";

type DashboardState =
  | { status: "loading" }
  | { status: "ready"; recordings: Recording[] }
  | { status: "failed"; message: string };

function newestFirst(recordings: readonly Recording[]): Recording[] {
  return [...recordings].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function RecordingItem({ recording }: { recording: Recording }) {
  const headingId = `recording-${recording.id}`;
  return (
    <article class="recording" aria-labelledby={headingId}>
      <h2 id={headingId}>{recording.name}</h2>
      <p>{recording.startUrl}</p>
      <p>{recording.eventCount === 1 ? "1 event" : `${recording.eventCount} events`}</p>
    </article>
  );
}

function Body({ state }: { state: DashboardState }) {
  switch (state.status) {
    case "loading":
      return <p role="status">Loading…</p>;
    case "failed":
      return <p role="alert">Could not read your data: {state.message}</p>;
    case "ready":
      if (state.recordings.length === 0) return <h2>No recordings yet</h2>;
      return (
        <>
          {state.recordings.map((recording) => (
            <RecordingItem key={recording.id} recording={recording} />
          ))}
        </>
      );
  }
}

export function Dashboard({ loadSnapshot }: { loadSnapshot: () => Promise<Snapshot> }) {
  const [state, setState] = useState<DashboardState>({ status: "loading" });

  useEffect(() => {
    loadSnapshot().then(
      (snapshot) => setState({ status: "ready", recordings: newestFirst(snapshot.recordings) }),
      (error: unknown) =>
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  }, [loadSnapshot]);

  return (
    <main class="dashboard">
      <h1>RECnRun</h1>
      <Body state={state} />
    </main>
  );
}

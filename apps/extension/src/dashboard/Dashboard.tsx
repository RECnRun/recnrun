import type { Recording, Snapshot } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";
import { nameMatchIndex, parseRoute } from "@/dashboard/route";
import type { DashboardRoute } from "@/dashboard/route";

type DashboardState =
  | { status: "loading" }
  | { status: "ready"; recordings: Recording[] }
  | { status: "failed"; message: string };

function newestFirst(recordings: readonly Recording[]): Recording[] {
  return [...recordings].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function RecordingItem({ recording, selected }: { recording: Recording; selected: boolean }) {
  const headingId = `recording-${recording.id}`;
  return (
    <article
      class={selected ? "recording recording--selected" : "recording"}
      aria-labelledby={headingId}
      aria-current={selected ? "true" : undefined}
    >
      <h2 id={headingId}>{recording.name}</h2>
      <p>{recording.startUrl}</p>
      <p>{recording.eventCount === 1 ? "1 event" : `${recording.eventCount} events`}</p>
    </article>
  );
}

/** The recordings a route shows and the status line that explains them. */
function applyRoute(recordings: Recording[], route: DashboardRoute) {
  switch (route.view) {
    case "all":
      return { shown: recordings, status: undefined };
    case "recording": {
      const match = recordings.find((recording) => recording.id === route.id);
      return {
        shown: recordings,
        status: match ? `Showing “${match.name}”` : "The requested recording was not found",
      };
    }
    case "search": {
      const shown = recordings.filter((r) => nameMatchIndex(r.name, route.query) >= 0);
      const count = shown.length === 1 ? "1 recording matches" : `${shown.length} recordings match`;
      return { shown, status: `${count} “${route.query}”` };
    }
  }
}

function RecordingList({ recordings, route }: { recordings: Recording[]; route: DashboardRoute }) {
  const { shown, status } = applyRoute(recordings, route);
  const selectedId = route.view === "recording" ? route.id : undefined;
  return (
    <>
      {status && <p role="status">{status}</p>}
      {shown.map((recording) => (
        <RecordingItem
          key={recording.id}
          recording={recording}
          selected={recording.id === selectedId}
        />
      ))}
    </>
  );
}

function Body({ state, route }: { state: DashboardState; route: DashboardRoute }) {
  switch (state.status) {
    case "loading":
      return <p role="status">Loading…</p>;
    case "failed":
      return <p role="alert">Could not read your data: {state.message}</p>;
    case "ready":
      if (state.recordings.length === 0) return <h2>No recordings yet</h2>;
      return <RecordingList recordings={state.recordings} route={route} />;
  }
}

/** Follows location.hash, which the omnibox changes on an open dashboard tab. */
function useHashRoute(): DashboardRoute {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return route;
}

export function Dashboard({ loadSnapshot }: { loadSnapshot: () => Promise<Snapshot> }) {
  const [state, setState] = useState<DashboardState>({ status: "loading" });
  const route = useHashRoute();

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
      <Body state={state} route={route} />
    </main>
  );
}

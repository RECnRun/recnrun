import type { Snapshot } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";
import { recordingPath, selectedRecordingId, titleFor } from "@/dashboard/route";

export interface DashboardProps {
  loadSnapshot: () => Promise<Snapshot>;
  initialRoute: string;
  subscribeRoute: (listener: (path: string) => void) => () => void;
  onLocation: (path: string, title: string) => void;
  openInTab: () => void;
}

type Load = { status: "loading" } | { status: "ready"; snapshot: Snapshot } | { status: "failed" };

function summary(load: Load): string {
  if (load.status === "loading") return "Loading…";
  if (load.status === "failed") return "Could not read your data";
  const count = load.snapshot.recordings.length;
  return count === 1 ? "1 recording" : `${count} recordings`;
}

export function Dashboard(props: DashboardProps) {
  const { loadSnapshot, subscribeRoute, onLocation, openInTab } = props;
  const [route, setRoute] = useState(props.initialRoute);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    loadSnapshot().then(
      (snapshot) => setLoad({ status: "ready", snapshot }),
      () => setLoad({ status: "failed" }),
    );
  }, [loadSnapshot]);
  useEffect(() => subscribeRoute(setRoute), [subscribeRoute]);
  useEffect(() => {
    const title = titleFor(load.status === "ready" ? load.snapshot : undefined, route);
    document.title = title;
    onLocation(route, title);
  }, [route, load, onLocation]);

  const selected = selectedRecordingId(route);
  return (
    <main class="dashboard">
      <h1>RECnRun dashboard</h1>
      <p role="status">{summary(load)}</p>
      <p data-testid="route">{route}</p>
      <ul aria-label="Recordings">
        {load.status === "ready" &&
          load.snapshot.recordings.map((recording) => (
            <li key={recording.id}>
              <a
                href={recordingPath(recording.id)}
                aria-current={recording.id === selected ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  setRoute(recordingPath(recording.id));
                }}
              >
                {recording.name}
              </a>
            </li>
          ))}
      </ul>
      <button type="button" onClick={openInTab}>
        Open in a new tab
      </button>
    </main>
  );
}

export function Refusal({ origin }: { origin: string }) {
  return (
    <main class="dashboard">
      <p role="alert">RECnRun does not run inside {origin}.</p>
    </main>
  );
}

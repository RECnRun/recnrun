import type { Snapshot } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";

type PopupState =
  | { status: "loading" }
  | { status: "ready"; recordings: number }
  | { status: "failed"; message: string };

function summary(state: PopupState): string {
  switch (state.status) {
    case "loading":
      return "Loading…";
    case "ready":
      return state.recordings === 1 ? "1 recording" : `${state.recordings} recordings`;
    case "failed":
      return `Could not read your data: ${state.message}`;
  }
}

export function Popup({ loadSnapshot }: { loadSnapshot: () => Promise<Snapshot> }) {
  const [state, setState] = useState<PopupState>({ status: "loading" });

  useEffect(() => {
    loadSnapshot().then(
      (snapshot) => setState({ status: "ready", recordings: snapshot.recordings.length }),
      (error: unknown) =>
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  }, [loadSnapshot]);

  return (
    <main class="popup">
      <h1>RECnRun</h1>
      <p role="status">{summary(state)}</p>
      <a href="https://recnrun.com" target="_blank" rel="noreferrer">
        Open recnrun.com
      </a>
    </main>
  );
}

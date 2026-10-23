import type { Snapshot } from "@recnrun/domain";
import { useEffect, useState } from "preact/hooks";

/** POC stub of the extension-hosted dashboard: it only proves the page loads and reads storage. */
export function Dashboard({ loadSnapshot }: { loadSnapshot: () => Promise<Snapshot> }) {
  const [summary, setSummary] = useState("Loading…");

  useEffect(() => {
    loadSnapshot().then(
      ({ recordings }) =>
        setSummary(recordings.length === 1 ? "1 recording" : `${recordings.length} recordings`),
      (error: unknown) => setSummary(`Could not read your data: ${String(error)}`),
    );
  }, [loadSnapshot]);

  return (
    <main>
      <h1>RECnRun dashboard</h1>
      <p role="status">{summary}</p>
    </main>
  );
}

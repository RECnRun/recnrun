import type { Event } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import type { Api } from "@/api/api";
import { useLoad } from "@/api/context";
import {
  type SnapshotRow,
  blobOf,
  imageSource,
  snapshotRows,
  unavailable,
  viewerDocument,
} from "@/features/run/viewer";
import { Button } from "@/ui/Button";
import { EmptyState, Loadable } from "@/ui/States";

type Kind = "page" | "screenshot";
type Shown = { row: SnapshotRow; kind: Kind; sha256: string };

/** Every snapshot event of the run, following the journal's cursor to its end. */
async function snapshotEvents(api: Api, runId: string): Promise<Event[]> {
  const events: Event[] = [];
  let cursor: string | undefined;
  do {
    const query = { runId, category: "snapshot", limit: 1000 } as const;
    const page = await api.call("run.queryEvents", cursor ? { ...query, cursor } : query);
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

const nameOf = ({ stepId, milestone }: SnapshotRow) => `${stepId}, ${milestone}`;

// The empty sandbox comes before `srcdoc`, so the captured page never loads with scripts allowed.
function Viewer({ runId, shown }: { runId: string; shown: Shown }) {
  const { loaded, reload } = useLoad(
    (api) => api.call("run.getArtifact", { runId, sha256: shown.sha256 }),
    `${runId}/${shown.sha256}`,
  );
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {(artifact) =>
        shown.kind === "page" ? (
          <iframe
            class="viewer"
            sandbox=""
            referrerpolicy="no-referrer"
            title={`Captured page of ${nameOf(shown.row)}`}
            srcdoc={viewerDocument(artifact.data)}
          />
        ) : (
          <img
            class="viewer"
            alt={`Screenshot of ${nameOf(shown.row)}`}
            src={imageSource(artifact)}
          />
        )
      }
    </Loadable>
  );
}

type PartProps = {
  row: SnapshotRow;
  kind: Kind;
  shown?: Shown | undefined;
  onShow: (s: Shown) => void;
};

function PartButton({ row, kind, shown, onShow }: PartProps) {
  const part = kind === "page" ? row.dom : row.screenshot;
  const sha256 = blobOf(part);
  const label = kind === "page" ? "Page" : "Screenshot";
  if (!sha256) return <span class="muted">{`${label}: ${unavailable(part) ?? ""}`}</span>;
  const pressed = shown?.row.key === row.key && shown.kind === kind;
  return (
    <Button aria-pressed={pressed} onClick={() => onShow({ row, kind, sha256 })}>
      {`View ${label.toLowerCase()}`}
    </Button>
  );
}

function SnapshotList({ runId, rows }: { runId: string; rows: SnapshotRow[] }) {
  const [shown, setShown] = useState<Shown>();
  if (rows.length === 0) return <EmptyState>This run captured no snapshots.</EmptyState>;
  return (
    <div class="stack">
      <ol class="list" aria-label="Snapshots">
        {rows.map((row) => (
          <li key={row.key} aria-label={`Snapshot ${nameOf(row)}`}>
            <code>{row.stepId}</code> {row.milestone}{" "}
            <PartButton row={row} kind="page" shown={shown} onShow={setShown} />{" "}
            <PartButton row={row} kind="screenshot" shown={shown} onShow={setShown} />
            {row.dom.condition === "truncated" ? (
              <p class="muted">The page was cut at the size cap.</p>
            ) : null}
          </li>
        ))}
      </ol>
      {shown ? <Viewer key={`${shown.row.key}/${shown.kind}`} runId={runId} shown={shown} /> : null}
    </div>
  );
}

/** The run's snapshots; a captured page renders inert in an empty sandbox under its own policy. */
export function Snapshots({ runId }: { runId: string }) {
  const { loaded, reload } = useLoad(
    async (api) => snapshotRows(await snapshotEvents(api, runId)),
    runId,
  );
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {(rows) => <SnapshotList runId={runId} rows={rows} />}
    </Loadable>
  );
}

import { useLoad } from "@/api/context";
import { allEvents } from "@/features/diagnostics/filters";
import { type BodyView, type RequestRow, pairRequests } from "@/features/diagnostics/pairing";
import { Badge } from "@/ui/Badge";
import { EmptyState, Loadable } from "@/ui/States";

/** A body's reference only: its bytes stay in the run's blobs and are never rendered here. */
function bodyText({ condition, mime, size, sha256, reason }: BodyView): string {
  const parts = [reason ? `${condition} (${reason})` : condition, mime];
  if (size !== undefined) parts.push(`${size} bytes`);
  if (sha256) parts.push(`sha256 ${sha256.slice(0, 12)}…`);
  return parts.filter(Boolean).join(", ");
}

function Row({ row }: { row: RequestRow }) {
  const failed = row.status === undefined || row.status >= 400;
  return (
    <tr>
      <td>{row.method ?? "?"}</td>
      <td class="url">{row.url}</td>
      <td>
        <Badge tone={failed ? "danger" : "neutral"}>{row.outcome}</Badge>
      </td>
      <td>{row.durationMs === undefined ? "unknown" : `${row.durationMs} ms`}</td>
      <td>{row.stepId ?? ""}</td>
      <td>
        {row.bodies.length === 0 ? (
          <span class="muted">none</span>
        ) : (
          row.bodies.map((body, index) => <p key={index}>{bodyText(body)}</p>)
        )}
      </td>
    </tr>
  );
}

function RequestTable({ rows }: { rows: RequestRow[] }) {
  if (rows.length === 0) return <EmptyState>This run recorded no network request.</EmptyState>;
  return (
    <div class="scroll">
      <table class="table" aria-label="Requests">
        <thead>
          <tr>
            <th>Method</th>
            <th>URL</th>
            <th>Response</th>
            <th>Time</th>
            <th>Step</th>
            <th>Body</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.requestId} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Each HTTP request of the run paired with its response, timing, and body references. */
export function Requests({ runId }: { runId: string }) {
  const { loaded, reload } = useLoad(
    async (api) => pairRequests(await allEvents(api, { runId, category: "network" })),
    runId,
  );
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {(rows) => <RequestTable rows={rows} />}
    </Loadable>
  );
}

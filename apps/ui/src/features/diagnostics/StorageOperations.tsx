import { useLoad } from "@/api/context";
import { allEvents } from "@/features/diagnostics/filters";
import { type StorageRow, storageRows } from "@/features/diagnostics/storage-rows";
import { Badge } from "@/ui/Badge";
import { EmptyState, Loadable } from "@/ui/States";

function StorageList({ rows }: { rows: StorageRow[] }) {
  if (rows.length === 0) return <EmptyState>This run recorded no storage operation.</EmptyState>;
  return (
    <ol class="list timeline" aria-label="Storage operations">
      {rows.map((row) => (
        <li key={row.key} aria-label={`Storage ${row.key}`}>
          <code>{row.time}</code> <Badge>{row.observation}</Badge> <code>{row.type}</code>
          <p class="event-summary">{row.detail}</p>
        </li>
      ))}
    </ol>
  );
}

/** Web Storage and cookie events with their transaction state: snapshot, observed change, or observed operation. */
export function StorageOperations({ runId }: { runId: string }) {
  const { loaded, reload } = useLoad(
    async (api) => storageRows(await allEvents(api, { runId, category: "storage" })),
    runId,
  );
  return (
    <Loadable loaded={loaded} onRetry={reload}>
      {(rows) => <StorageList rows={rows} />}
    </Loadable>
  );
}

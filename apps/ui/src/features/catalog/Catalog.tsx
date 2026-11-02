import type { FlowCatalogEntry } from "@recnrun/protocol";
import { useLoad } from "@/api/context";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { EmptyState, Loadable } from "@/ui/States";

type CatalogProps = { onOpen: (flowId: string) => void; onRecord: () => void };

function Rows({ flows, onOpen }: { flows: FlowCatalogEntry[]; onOpen: (id: string) => void }) {
  return (
    <table class="table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Status</th>
          <th scope="col">Revision</th>
          <th scope="col">Updated</th>
          <th scope="col">
            <span class="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {flows.map((flow) => (
          <tr key={flow.id}>
            <td>{flow.name}</td>
            <td>
              <Badge tone={flow.status === "validated" ? "success" : "neutral"}>
                {flow.status}
              </Badge>
            </td>
            <td>
              <code title={flow.revision}>{flow.revision.slice(0, 12)}</code>
            </td>
            <td>
              <time dateTime={flow.updatedAt}>{flow.updatedAt}</time>
            </td>
            <td>
              <Button onClick={() => onOpen(flow.id)} aria-label={`Open ${flow.name}`}>
                Open
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The flows the service knows, newest state first as the index returns them. */
export function Catalog({ onOpen, onRecord }: CatalogProps) {
  const { loaded, reload } = useLoad((api) => api.call("flow.list", {}), "flows");
  const record = (
    <Button variant="primary" onClick={onRecord}>
      New recording
    </Button>
  );
  return (
    <Card title="Flows" actions={record}>
      <Loadable loaded={loaded} onRetry={reload}>
        {({ flows }) =>
          flows.length === 0 ? (
            <EmptyState>No flows yet. Record one to start.</EmptyState>
          ) : (
            <Rows flows={flows} onOpen={onOpen} />
          )
        }
      </Loadable>
    </Card>
  );
}

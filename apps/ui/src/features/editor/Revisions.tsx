import type { Flow } from "@recnrun/protocol";
import { useState } from "preact/hooks";
import { useAction, useApi } from "@/api/context";
import { type FlowDiff, compareFlows } from "@/features/editor/diff";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { ErrorState } from "@/ui/States";

export type RevisionEntry = { revision: string; savedAt: string };

export const short = (revision: string) => revision.slice(0, 12);

const when = (savedAt: string) => savedAt.replace("T", " ").slice(0, 19);

function DiffTable({ revision, diff }: { revision: string; diff: FlowDiff }) {
  return (
    <table class="table" aria-label="Revisions compared">
      <caption>
        Revision <code>{short(revision)}</code> compared with the flow as edited
      </caption>
      <thead>
        <tr>
          <th>Kind</th>
          <th>Part</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>
        {diff.fields.map(({ name, change }) => (
          <tr key={`field ${name}`}>
            <td>field</td>
            <td>
              <code>{name}</code>
            </td>
            <td>{change}</td>
          </tr>
        ))}
        {diff.steps.map(({ id, change }) => (
          <tr key={`step ${id}`}>
            <td>step</td>
            <td>
              <code>{id}</code>
            </td>
            <td>{change}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Props = { flowId: string; history: RevisionEntry[]; current: string; flow: Flow };

/** The flow's revisions, newest first; a past one is fetched and compared with the flow as edited. */
export function Revisions({ flowId, history, current, flow }: Props) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [past, setPast] = useState<{ revision: string; flow: Flow }>();
  const compare = (revision: string) =>
    run(async () => {
      const got = await api.call("flow.getRevision", { flowId, revision });
      setPast({ revision, flow: got.flow });
    });
  return (
    <Card title="Revisions">
      <ol class="list" aria-label="Revisions">
        {[...history].reverse().map((entry) => (
          <li key={entry.revision} class="row">
            <code>{short(entry.revision)}</code>
            <time dateTime={entry.savedAt}>{when(entry.savedAt)}</time>
            {entry.revision === current ? (
              <Badge tone="success">current</Badge>
            ) : (
              <Button disabled={busy} onClick={() => compare(entry.revision)}>
                Compare with {short(entry.revision)}
              </Button>
            )}
          </li>
        ))}
      </ol>
      {error ? <ErrorState error={error} /> : null}
      {past ? <DiffTable revision={past.revision} diff={compareFlows(past.flow, flow)} /> : null}
    </Card>
  );
}

import { useEffect, useState } from "preact/hooks";
import type { CloneControl, CloneControlSnapshot } from "@/onboarding/clone-control-service";
import type { CloneAction, CloneRow } from "@/p2p/clone-control";

function useSnapshot(control: CloneControl): CloneControlSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<CloneControlSnapshot>();
  useEffect(() => control.watch(setSnapshot), [control]);
  return snapshot;
}

/** The buttons a clone offers in its state; an opening clone offers none. */
export function actionsOf(row: CloneRow): [string, CloneAction][] {
  if (row.state === "closed") {
    return [
      ["Open visible", "open-visible"],
      ["Open headless", "open-headless"],
    ];
  }
  if (row.state === "opening") return [];
  const reopen: [string, CloneAction][] = [
    ["Reopen visible", "reopen-visible"],
    ["Reopen headless", "reopen-headless"],
  ];
  const other = reopen.filter(
    ([, action]) => !action.endsWith(row.mode === "headless" ? "headless" : "visible"),
  );
  return [["Close", "close"], ...(row.mode === "" ? reopen : other)];
}

function Row(props: { row: CloneRow; busy: boolean; control: CloneControl }) {
  const { row, busy, control } = props;
  return (
    <li data-field="clone">
      <span data-field="name">{row.name}</span>{" "}
      <span data-field="state">
        {row.state}
        {row.mode && ` (${row.mode})`}
      </span>
      {actionsOf(row).map(([label, action]) => (
        <button
          type="button"
          key={action}
          disabled={busy}
          onClick={() => void control.ask(row.instanceId, action)}
        >
          {label}
        </button>
      ))}
    </li>
  );
}

/** The master's "Clones" section (POC P7.6): one request at a time, then the launcher's answer. */
export function CloneControlPanel({ control }: { control: CloneControl }) {
  const snapshot = useSnapshot(control);
  if (!snapshot) return null;
  const busy = snapshot.pending !== undefined;
  return (
    <section class="prepare-workers clone-control" aria-labelledby="clone-control-heading">
      <h3 id="clone-control-heading">Clones</h3>
      {snapshot.clones.length === 0 && <p>No clones yet.</p>}
      <ul>
        {snapshot.clones.map((row) => (
          <Row key={row.instanceId} row={row} busy={busy} control={control} />
        ))}
      </ul>
      {snapshot.pending && (
        <p role="status" data-field="pending">
          Waiting for the launcher: {snapshot.pending.action}
        </p>
      )}
      <p data-field="message">{snapshot.message}</p>
      {snapshot.failure && (
        <p role="alert" data-field="failure">
          {snapshot.failure}
        </p>
      )}
    </section>
  );
}

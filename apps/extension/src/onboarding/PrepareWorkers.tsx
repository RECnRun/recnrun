import { useEffect, useState } from "preact/hooks";
import type { Onboarding, OnboardingSnapshot } from "@/onboarding/service";
import type { Phase } from "@/onboarding/state";
import { MAX_CLONES } from "@/p2p/prepare";

const BUSY: Phase[] = ["requested", "running", "pending-action", "retrying"];

function useSnapshot(onboarding: Onboarding): OnboardingSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot>();
  useEffect(() => onboarding.watch(setSnapshot), [onboarding]);
  return snapshot;
}

function Clones({ rows }: { rows: OnboardingSnapshot["clones"] }) {
  if (rows.length === 0) return null;
  return (
    <table data-field="clones">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Instance</th>
          <th scope="col">Acked</th>
          <th scope="col">Linked</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.instanceId} data-field="clone">
            <td data-field="name">{row.name}</td>
            <td data-field="instance-id">{row.instanceId}</td>
            <td data-field="acked">{String(row.acked)}</td>
            <td data-field="linked">{String(row.linked)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Fields(props: {
  basesDir: string;
  clones: string;
  setBasesDir: (value: string) => void;
  setClones: (value: string) => void;
}) {
  return (
    <>
      <label for="prepare-bases-dir">Bases folder</label>
      <input
        id="prepare-bases-dir"
        data-field="bases-dir"
        value={props.basesDir}
        placeholder="Leave blank for ~/RECnRun/bases"
        onInput={(event) => props.setBasesDir(event.currentTarget.value)}
      />
      <label for="prepare-clones">Workers</label>
      <input
        id="prepare-clones"
        data-field="clones-count"
        type="number"
        min={1}
        max={MAX_CLONES}
        value={props.clones}
        onInput={(event) => props.setClones(event.currentTarget.value)}
      />
    </>
  );
}

/** The master's "Prepare workers" section (POC P6.1): ask once, then watch the launcher's answer. */
export function PrepareWorkers({ onboarding }: { onboarding: Onboarding }) {
  const snapshot = useSnapshot(onboarding);
  const [basesDir, setBasesDir] = useState("");
  const [clones, setClones] = useState("2");
  if (!snapshot) return null;
  return (
    <section class="prepare-workers" aria-labelledby="prepare-workers-heading">
      <h3 id="prepare-workers-heading">Prepare workers</h3>
      <p>The launcher makes the base, freezes it, and opens the clones.</p>
      <Fields {...{ basesDir, clones, setBasesDir, setClones }} />
      <button
        type="button"
        data-field="prepare"
        disabled={BUSY.includes(snapshot.phase)}
        onClick={() => void onboarding.request(basesDir, Number(clones))}
      >
        Prepare
      </button>
      <p role="status" data-field="phase">
        {snapshot.phase}
      </p>
      <p data-field="step">{snapshot.step}</p>
      <p data-field="message">{snapshot.message}</p>
      {snapshot.failure && (
        <p role="alert" data-field="failure">
          {snapshot.failure}
        </p>
      )}
      <Clones rows={snapshot.clones} />
      {snapshot.phase === "error" && (
        <button type="button" data-field="retry" onClick={() => void onboarding.retry()}>
          Retry
        </button>
      )}
      {snapshot.phase === "done" && <p data-field="done">Done</p>}
    </section>
  );
}

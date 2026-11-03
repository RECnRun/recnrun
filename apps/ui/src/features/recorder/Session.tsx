import {
  type GapPayload,
  PAUSE_MODES,
  type PauseMode,
  type SessionStatus,
} from "@recnrun/protocol";
import { useSession } from "@/features/recorder/useSession";
import { Suggestions } from "@/features/recorder/Suggestions";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { EmptyState, ErrorState } from "@/ui/States";

const PAUSE_LABELS: Record<PauseMode, string> = {
  pauseStepCreation: "Pause step creation",
  pauseReplay: "Pause replay",
  suspendCapture: "Suspend capture",
};

function Coverage({ gaps, suspended }: { gaps: GapPayload[]; suspended: boolean }) {
  if (gaps.length === 0 && !suspended) return <EmptyState>No coverage gaps so far.</EmptyState>;
  return (
    <ul class="list">
      {suspended ? <li>Capture is suspended: nothing is observed until you resume it.</li> : null}
      {gaps.map((gap, index) => (
        <li key={index}>
          <Badge tone="danger">gap</Badge> {gap.reason}
          {gap.surface ? ` on ${gap.surface}` : ""}
          {gap.lost === undefined ? "" : `, ${gap.lost} events lost`}
        </li>
      ))}
    </ul>
  );
}

type SessionProps = {
  initial: SessionStatus;
  onFinalized: (flowId: string) => void;
  pollMs?: number | undefined;
};

/** A running recording: its state, the three pauses, control, suggestions, and coverage. */
export function Session({ initial, onFinalized, pollMs }: SessionProps) {
  const session = useSession(initial, onFinalized, pollMs);
  const { status, busy } = session;
  const actions = (
    <>
      <Button disabled={busy || status.control === "manual"} onClick={session.takeControl}>
        Take control
      </Button>
      <Button variant="primary" disabled={busy} onClick={session.stop}>
        Stop and save
      </Button>
    </>
  );
  return (
    <div class="stack">
      <Card title="Recording" actions={actions}>
        <p>
          Session <code>{status.sessionId}</code> <Badge>{status.state}</Badge> Control:{" "}
          <Badge>{status.control}</Badge>
        </p>
        <div class="row" role="group" aria-label="Pauses">
          {PAUSE_MODES.map((mode) => (
            <Button
              key={mode}
              aria-pressed={status.pauses[mode] === "paused"}
              disabled={busy}
              onClick={() => session.togglePause(mode)}
            >
              {PAUSE_LABELS[mode]}
            </Button>
          ))}
        </div>
        {session.error ? <ErrorState error={session.error} /> : null}
      </Card>
      <Card title="Suggested steps">
        <Suggestions result={session.suggestions} />
      </Card>
      <Card title="Coverage">
        <Coverage gaps={session.gaps} suspended={status.pauses.suspendCapture === "paused"} />
      </Card>
    </div>
  );
}

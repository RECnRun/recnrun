import type { LeaseFence, PauseMode, SessionStatus } from "@recnrun/protocol";
import { PAUSE_MODES } from "@recnrun/protocol";
import type { ComponentChildren } from "preact";
import { useSession } from "@/features/recorder/useSession";
import { Suggestions } from "@/features/recorder/Suggestions";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { ErrorState } from "@/ui/States";

/** What `src/app` renders inside a running recording, such as the assertion picker. */
export type SessionSlot = (session: { sessionId: string; lease?: LeaseFence }) => ComponentChildren;

const PAUSE_LABELS: Record<PauseMode, string> = {
  pauseStepCreation: "Pause step creation",
  pauseReplay: "Pause replay",
  suspendCapture: "Suspend capture",
};

// The Run screen lists a run's collector gaps (F3.5); a live session shows only that capture is suspended.
function Coverage({ suspended }: { suspended: boolean }) {
  if (!suspended) return <p class="muted">Capture is on for this page and the popups it opens.</p>;
  return <p>Capture is suspended: nothing is observed until you resume it.</p>;
}

type SessionProps = {
  initial: SessionStatus;
  onFinalized: (flowId: string) => void;
  pollMs?: number | undefined;
  slot?: SessionSlot | undefined;
};

/** A running recording: its state, the three pauses, control, suggestions, and coverage. */
export function Session({ initial, onFinalized, pollMs, slot }: SessionProps) {
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
        <Coverage suspended={status.pauses.suspendCapture === "paused"} />
      </Card>
      {slot
        ? slot({ sessionId: status.sessionId, ...(status.lease && { lease: status.lease }) })
        : null}
    </div>
  );
}

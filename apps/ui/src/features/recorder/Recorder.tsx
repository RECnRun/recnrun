import type { ProfileBinding, SessionStatus } from "@recnrun/protocol";
import { useEffect, useState } from "preact/hooks";
import { useAction, useApi, useLoad } from "@/api/context";
import { Session, type SessionSlot } from "@/features/recorder/Session";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Field } from "@/ui/Field";
import { ErrorState, Loadable } from "@/ui/States";

type StartProps = { profiles: ProfileBinding[]; onStarted: (status: SessionStatus) => void };

function StartForm({ profiles, onStarted }: StartProps) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [actor, setActor] = useState("");
  const [binding, setBinding] = useState("");
  const start = (event: Event) => {
    event.preventDefault();
    run(async () => {
      const actors = actor && binding ? { [actor]: binding } : undefined;
      onStarted(await api.call("session.start", actors ? { actors } : {}));
    });
  };
  return (
    <form class="stack" onSubmit={start}>
      <p class="muted">Optionally name the actor you record as and the Chrome profile it uses.</p>
      <div class="row">
        <Field label="Actor">
          <input
            value={actor}
            placeholder="requester"
            onInput={(event) => setActor(event.currentTarget.value)}
          />
        </Field>
        <Field label="Binding">
          <select value={binding} onChange={(event) => setBinding(event.currentTarget.value)}>
            <option value="">Default profile</option>
            {profiles.map((profile) => (
              <option key={profile.name} value={profile.name}>
                {profile.name}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>
          Start recording
        </Button>
      </div>
      {error ? <ErrorState error={error} /> : null}
    </form>
  );
}

type ResumeProps = {
  sessionId: string;
  onResumed: (status: SessionStatus) => void;
  onGone: () => void;
};

/** Reads a session this tab started before, then shows it again unless it is gone or saved. */
function Resume({ sessionId, onResumed, onGone }: ResumeProps) {
  const { loaded, reload } = useLoad((api) => api.call("session.status", { sessionId }), sessionId);
  useEffect(() => {
    if (loaded.state === "ready") {
      if (loaded.value.state === "completed") onGone();
      else onResumed(loaded.value);
    } else if (loaded.state === "error" && loaded.error.code === "not-found") onGone();
  }, [loaded]);
  return (
    <Card title="Resuming recording">
      <Loadable loaded={loaded} onRetry={reload}>
        {() => null}
      </Loadable>
    </Card>
  );
}

type ActiveSession = [string | undefined, (sessionId: string | undefined) => void];

type RecorderProps = {
  onFinalized: (flowId: string) => void;
  pollMs?: number;
  /** Rendered inside the running session; `src/app` passes the assertion picker. */
  slot?: SessionSlot;
  /** The session this tab runs, which `src/app` keeps above routing; without it, the Recorder keeps it. */
  active?: ActiveSession;
};

/** Starts a recording session, then follows it until it is stopped and saved as a flow. */
export function Recorder({ onFinalized, pollMs, slot, active }: RecorderProps) {
  const local = useState<string>();
  const [sessionId, setSessionId] = active ?? local;
  const [status, setStatus] = useState<SessionStatus>();
  const { loaded, reload } = useLoad((api) => api.call("profiles.list", {}), "profiles");
  const started = (next: SessionStatus) => {
    setSessionId(next.sessionId);
    setStatus(next);
  };
  const finalized = (flowId: string) => {
    setSessionId(undefined);
    onFinalized(flowId);
  };
  if (status)
    return <Session initial={status} onFinalized={finalized} pollMs={pollMs} slot={slot} />;
  if (sessionId)
    return (
      <Resume sessionId={sessionId} onResumed={setStatus} onGone={() => setSessionId(undefined)} />
    );
  return (
    <Card title="New recording">
      <Loadable loaded={loaded} onRetry={reload}>
        {({ profiles }) => <StartForm profiles={profiles} onStarted={started} />}
      </Loadable>
    </Card>
  );
}

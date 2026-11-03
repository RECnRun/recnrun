import type { ProfileBinding, SessionStatus } from "@recnrun/protocol";
import { useState } from "preact/hooks";
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

type RecorderProps = {
  onFinalized: (flowId: string) => void;
  pollMs?: number;
  /** Rendered inside the running session; `src/app` passes the assertion picker. */
  slot?: SessionSlot;
};

/** Starts a recording session, then follows it until it is stopped and saved as a flow. */
export function Recorder({ onFinalized, pollMs, slot }: RecorderProps) {
  const [status, setStatus] = useState<SessionStatus>();
  const { loaded, reload } = useLoad((api) => api.call("profiles.list", {}), "profiles");
  if (status)
    return <Session initial={status} onFinalized={onFinalized} pollMs={pollMs} slot={slot} />;
  return (
    <Card title="New recording">
      <Loadable loaded={loaded} onRetry={reload}>
        {({ profiles }) => <StartForm profiles={profiles} onStarted={setStatus} />}
      </Loadable>
    </Card>
  );
}
